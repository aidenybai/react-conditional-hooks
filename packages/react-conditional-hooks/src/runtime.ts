import {
  MemoComponentTag,
  OffscreenComponentTag,
  SimpleMemoComponentTag,
  _renderers,
  getRDTHook,
  instrument,
  isValidFiber,
  onRendererInject,
  toUnsubscribe,
  traverseFiber,
  type Fiber,
  type FiberRoot,
  type ReactRenderer,
} from "bippy";

import {
  AUTOMATIC_HOOK_KEY_PREFIX,
  CONDITIONAL_HOOKS_INSTRUMENTATION_NAME,
  CONDITIONAL_UPDATE_PROPERTY,
  HIDDEN_SUBTREE_MODE,
  REACT_19_ACTIVITY_COMPONENT_TAG,
  STRICT_EFFECTS_MODE,
  STRICT_LEGACY_MODE,
} from "./constants.js";
import type {
  ActiveConditionalRuntime,
  ActiveConditionalScope,
  ConditionalEffectCell,
  ConditionalEffectKind,
  ConditionalEffectRegistration,
  ConditionalHookDispatcher,
  ConditionalHookKind,
  ConditionalHookRuntime,
  ConditionalHooksInstallation,
  ConditionalHooksOptions,
  ConditionalHookScope,
  ConditionalReducerCell,
  ConditionalReducerDispatcher,
  ConditionalRef,
  ConditionalRenderFrame,
  ConditionalStateCell,
  ConditionalStateSetter,
  ConditionalVisibilityState,
} from "./types.js";
import { getHookCallsiteKey } from "./utils/get-hook-callsite-key.js";

const runtimes = new Set<ConditionalHookRuntime>();
const scopes = new Set<ConditionalHookScope>();
const runtimeByDispatcherRef = new WeakMap<object, ConditionalHookRuntime>();
const scopeByFiber = new WeakMap<Fiber, ConditionalHookScope>();
const renderFrameByFiber = new WeakMap<Fiber, ConditionalRenderFrame>();

let installation: ConditionalHooksInstallation | null = null;
let scheduledUpdateVersion = 0;

const getCurrentFiber = (renderer: ReactRenderer): Fiber | null => {
  try {
    if (!renderer.getCurrentFiber) return null;
    const fiber: unknown = Reflect.apply(renderer.getCurrentFiber, renderer, []);
    return isValidFiber(fiber) ? fiber : null;
  } catch {
    return null;
  }
};

const isContextOnlyDispatcher = (dispatcher: ConditionalHookDispatcher | null): boolean => {
  if (!dispatcher) return true;
  return (
    typeof dispatcher.useState === "function" &&
    dispatcher.useState === dispatcher.useReducer &&
    dispatcher.useReducer === dispatcher.useRef &&
    dispatcher.useRef === dispatcher.useEffect
  );
};

const getAutomaticHookKey = (runtime: ConditionalHookRuntime, hookName: string): PropertyKey => {
  const { frame } = getScope();
  const stack = new Error().stack ?? "";
  const callsiteKey = runtime.getHookKey(hookName, stack);
  const occurrence = frame.callCounts.get(callsiteKey) ?? 0;
  frame.callCounts.set(callsiteKey, occurrence + 1);
  return `${AUTOMATIC_HOOK_KEY_PREFIX}:${String(callsiteKey)}:${occurrence}`;
};

const getDependencies = (value: unknown): readonly unknown[] | undefined =>
  Array.isArray(value) ? value : undefined;

/**
 * React's public hook functions are only thin calls into the current dispatcher.
 * Intercepting that dispatcher lets application code keep calling React.useState
 * and friends, so there is no parallel keyed-hook API for consumers to learn.
 *
 * The proxy replaces only hooks whose state must stop using React's positional
 * linked list. Context still delegates to React because provider lookup belongs
 * to the renderer, and every unsupported hook falls through unchanged. Proxies
 * are cached per native dispatcher because React swaps dispatcher objects across
 * mount, update, rerender, and invalid-hook phases.
 */
const createDispatcherProxy = (
  runtime: ConditionalHookRuntime,
  dispatcher: ConditionalHookDispatcher,
): ConditionalHookDispatcher =>
  new Proxy(dispatcher, {
    get: (target, property, receiver) => {
      if (property === "useState") {
        return (initialState: unknown) =>
          readStateCell(getAutomaticHookKey(runtime, "useState"), initialState);
      }
      if (property === "useReducer") {
        return (reducer: unknown, initialState: unknown, initialize: unknown) => {
          if (typeof reducer !== "function") throw new TypeError("useReducer requires a reducer.");
          const initializer =
            typeof initialize === "function" ? (value: unknown) => initialize(value) : undefined;
          return readReducerCell(
            getAutomaticHookKey(runtime, "useReducer"),
            (state: unknown, action: unknown) => reducer(state, action),
            initialState,
            initializer,
          );
        };
      }
      if (property === "useRef") {
        return (initialValue: unknown) =>
          readRefCell(getAutomaticHookKey(runtime, "useRef"), initialValue);
      }
      if (property === "useMemo") {
        return (create: unknown, dependencies: unknown) => {
          if (typeof create !== "function") throw new TypeError("useMemo requires a function.");
          return readMemoCell(
            getAutomaticHookKey(runtime, "useMemo"),
            () => create(),
            getDependencies(dependencies),
          );
        };
      }
      if (property === "useCallback") {
        return (callback: unknown, dependencies: unknown) => {
          if (typeof callback !== "function") {
            throw new TypeError("useCallback requires a function.");
          }
          return readMemoCell(
            getAutomaticHookKey(runtime, "useCallback"),
            () => callback,
            getDependencies(dependencies),
          );
        };
      }
      if (property === "useEffect" || property === "useLayoutEffect") {
        return (create: unknown, dependencies: unknown) => {
          if (typeof create !== "function") {
            throw new TypeError(`${property} requires a function.`);
          }
          registerEffect(
            getAutomaticHookKey(runtime, property),
            property === "useEffect" ? "effect" : "layout-effect",
            () => create(),
            getDependencies(dependencies),
          );
        };
      }
      if (property === "useContext" && typeof target.readContext === "function") {
        return target.readContext;
      }
      if (property === "useDebugValue") return (): void => {};
      return Reflect.get(target, property, receiver);
    },
  });

const getRuntimeDispatcher = (
  runtime: ConditionalHookRuntime,
): ConditionalHookDispatcher | null => {
  const dispatcher = runtime.currentDispatcher;
  if (!dispatcher || isContextOnlyDispatcher(dispatcher)) {
    return dispatcher;
  }
  const existingProxy = runtime.proxyByDispatcher.get(dispatcher);
  if (existingProxy) return existingProxy;
  const proxy = createDispatcherProxy(runtime, dispatcher);
  runtime.proxyByDispatcher.set(dispatcher, proxy);
  return proxy;
};

const associateScopeWithFiber = (scope: ConditionalHookScope, fiber: Fiber): void => {
  scope.fiber = fiber;
  scopeByFiber.set(fiber, scope);
  if (fiber.alternate) scopeByFiber.set(fiber.alternate, scope);
};

/**
 * A render frame is a transaction buffer for one component render. Hook reads
 * write cells, effects, and render-phase updates here instead of mutating the
 * committed scope. React can suspend, throw, or abandon this render at any
 * point. In those cases the frame is never visited by commitRoot, so none of
 * its speculative state escapes into the mounted component.
 *
 * Strict Mode is the one exception during an initial mount. React intentionally
 * invokes the component twice before committing. The second attempt receives a
 * copy of the first attempt's cells so initializers can replay while the values
 * selected by the first attempt remain authoritative.
 */
const createRenderFrame = (
  scope: ConditionalHookScope,
  fiber: Fiber,
  previousFrame?: ConditionalRenderFrame,
): ConditionalRenderFrame => {
  const shouldReplayStrictCells =
    !scope.didCommit && (fiber.mode & STRICT_LEGACY_MODE) !== 0 && previousFrame !== undefined;

  return {
    callCounts: new Map(),
    cells: shouldReplayStrictCells ? new Map(previousFrame.cells) : new Map(),
    effects: new Map(),
    fiber,
    hookKinds: new Map(),
    reducerActionCounts: new Map(),
    reducerOverrides: new Map(),
    replayedCells: shouldReplayStrictCells ? new Set(previousFrame.cells.keys()) : new Set(),
    renderPhaseUpdates: new Map(),
    scope,
  };
};

const beginRender = (runtime: ConditionalHookRuntime, fiber: Fiber): void => {
  runtime.activeFiber = fiber;
  const scope =
    scopeByFiber.get(fiber) ?? (fiber.alternate ? scopeByFiber.get(fiber.alternate) : undefined);
  if (!scope) return;
  const previousFrame = renderFrameByFiber.get(fiber);
  associateScopeWithFiber(scope, fiber);
  renderFrameByFiber.set(fiber, createRenderFrame(scope, fiber, previousFrame));
};

const handleDispatcherChange = (
  runtime: ConditionalHookRuntime,
  dispatcher: ConditionalHookDispatcher | null,
): void => {
  const previousDispatcher = runtime.currentDispatcher;
  runtime.currentDispatcher = dispatcher;
  if (isContextOnlyDispatcher(dispatcher)) {
    runtime.activeFiber = null;
    return;
  }
  const fiber = getCurrentFiber(runtime.renderer);
  if (fiber && (fiber !== runtime.activeFiber || dispatcher !== previousDispatcher)) {
    beginRender(runtime, fiber);
  }
};

const restoreRuntime = (runtime: ConditionalHookRuntime): void => {
  const descriptor = runtime.originalDescriptor;
  if (descriptor) {
    Object.defineProperty(runtime.dispatcherRef, runtime.dispatcherKey, descriptor);
    runtime.dispatcherRef[runtime.dispatcherKey] = runtime.currentDispatcher;
  } else {
    delete runtime.dispatcherRef[runtime.dispatcherKey];
    runtime.dispatcherRef[runtime.dispatcherKey] = runtime.currentDispatcher;
  }
  runtimes.delete(runtime);
  runtimeByDispatcherRef.delete(runtime.dispatcherRef);
};

/**
 * Development renderers expose their current dispatcher ref to React DevTools.
 * The ref is more useful than the exported React object because React itself
 * reads it for every hook call. Replacing its property descriptor gives us two
 * synchronized signals: the setter tells us when React enters a new component
 * render, and the getter supplies the cached proxy for that exact dispatcher.
 *
 * Production renderers omit getCurrentFiber and scheduleUpdate. Rejecting those
 * renderers up front keeps this experiment honest instead of installing a
 * partially working runtime that loses component identity or cannot rerender.
 */
const installRenderer = (renderer: ReactRenderer, options: ConditionalHooksOptions): boolean => {
  if (
    typeof renderer.getCurrentFiber !== "function" ||
    typeof renderer.scheduleUpdate !== "function"
  ) {
    return false;
  }
  const dispatcherRef = renderer.currentDispatcherRef;
  if (!dispatcherRef || typeof dispatcherRef !== "object") return false;
  if (runtimeByDispatcherRef.has(dispatcherRef)) return true;

  const dispatcherKey = "H" in dispatcherRef ? "H" : "current";
  const originalDescriptor = Object.getOwnPropertyDescriptor(dispatcherRef, dispatcherKey);
  if (originalDescriptor?.configurable === false) return false;

  const runtime: ConditionalHookRuntime = {
    activeFiber: null,
    currentDispatcher: dispatcherRef[dispatcherKey] ?? null,
    dispatcherKey,
    dispatcherRef,
    getHookKey: options.getHookKey ?? getHookCallsiteKey,
    originalDescriptor,
    proxyByDispatcher: new WeakMap(),
    renderer,
  };

  Object.defineProperty(dispatcherRef, dispatcherKey, {
    configurable: true,
    enumerable: originalDescriptor?.enumerable ?? true,
    get: () => getRuntimeDispatcher(runtime),
    set: (dispatcher: ConditionalHookDispatcher | null) => {
      handleDispatcherChange(runtime, dispatcher);
    },
  });

  runtimes.add(runtime);
  runtimeByDispatcherRef.set(dispatcherRef, runtime);
  return true;
};

const getActiveRuntime = (): ActiveConditionalRuntime => {
  for (const runtime of runtimes) {
    const fiber = runtime.activeFiber ?? getCurrentFiber(runtime.renderer);
    if (fiber) {
      if (runtime.activeFiber !== fiber) beginRender(runtime, fiber);
      return { fiber, runtime };
    }
  }
  throw new Error(
    "Conditional hooks require a React development renderer and must be called while a component is rendering. Call installConditionalHooks() before rendering.",
  );
};

/**
 * A scope is the committed side table for one mounted component instance.
 * React alternates between current and work-in-progress Fiber objects, so both
 * objects must resolve to the same scope. The scope never touches
 * fiber.memoizedState, which keeps React's own positional hook list intact and
 * lets ordinary and conditional hooks coexist inside the same component.
 *
 * The render frame is created lazily because the dispatcher can announce a
 * Fiber before the component reaches its first intercepted hook.
 */
const getScope = (): ActiveConditionalScope => {
  const { fiber, runtime } = getActiveRuntime();
  let scope =
    scopeByFiber.get(fiber) ?? (fiber.alternate ? scopeByFiber.get(fiber.alternate) : undefined);
  if (!scope) {
    scope = {
      cells: new Map(),
      didCommit: false,
      didUnmount: false,
      effects: new Map(),
      fiber,
      hookKinds: new Map(),
      layoutEffectsDisconnected: false,
      passiveEffectsDisconnected: false,
      renderer: runtime.renderer,
    };
    associateScopeWithFiber(scope, fiber);
  }
  let frame = renderFrameByFiber.get(fiber);
  if (!frame || frame.scope !== scope) {
    frame = createRenderFrame(scope, fiber);
    renderFrameByFiber.set(fiber, frame);
  }
  return { frame, scope };
};

const registerHookKind = (
  frame: ConditionalRenderFrame,
  scope: ConditionalHookScope,
  key: PropertyKey,
  kind: ConditionalHookKind,
): void => {
  const previousKind = frame.hookKinds.get(key) ?? scope.hookKinds.get(key);
  if (previousKind && previousKind !== kind) {
    throw new Error(
      `Conditional hook key ${String(key)} changed from ${previousKind} to ${kind}. Keys must identify one hook callsite.`,
    );
  }
  frame.hookKinds.set(key, kind);
};

/**
 * Conditional state is invisible to React's normal hook update queues. Bippy's
 * scheduleUpdate can put the owning Fiber back on the scheduler, but React may
 * still bail out when props look referentially unchanged. The props clones make
 * that external state change observable without inserting a fake hook or lane
 * into React's private memoizedState list.
 */
const scheduleScopeUpdate = (scope: ConditionalHookScope): void => {
  if (scope.didUnmount) return;
  const scheduleUpdate = scope.renderer.scheduleUpdate;
  if (!scheduleUpdate) {
    throw new Error("The active React renderer does not expose scheduleUpdate().");
  }

  // HACK: DevTools schedules a no-op lane. Cloning props defeats the ordinary
  // bailout, and memo Fibers also receive a private version so their wrapper
  // comparison cannot swallow the update before the inner component renders.
  const currentFiber = getCurrentFiberBranch(scope.fiber);
  currentFiber.memoizedProps = { ...currentFiber.memoizedProps };
  if (currentFiber.tag === MemoComponentTag || currentFiber.tag === SimpleMemoComponentTag) {
    const pendingProps = {
      ...currentFiber.pendingProps,
      [CONDITIONAL_UPDATE_PROPERTY]: ++scheduledUpdateVersion,
    };
    currentFiber.pendingProps = pendingProps;
    if (currentFiber.alternate) currentFiber.alternate.pendingProps = pendingProps;
  }
  scheduleUpdate(currentFiber);
};

const getCurrentFiberBranch = (fiber: Fiber): Fiber => {
  let root = fiber;
  while (root.return) root = root.return;
  if (root.stateNode?.current === root) return fiber;
  return fiber.alternate ?? fiber;
};

const getRenderFrameForScope = (
  scope: ConditionalHookScope,
): ConditionalRenderFrame | undefined => {
  const fiber = getCurrentFiber(scope.renderer);
  if (!fiber) return undefined;
  const activeScope =
    scopeByFiber.get(fiber) ?? (fiber.alternate ? scopeByFiber.get(fiber.alternate) : undefined);
  if (activeScope !== scope) return undefined;
  return renderFrameByFiber.get(fiber);
};

const enqueueRenderPhaseUpdate = (
  frame: ConditionalRenderFrame,
  key: PropertyKey,
  action: unknown,
): void => {
  const updates = frame.renderPhaseUpdates.get(key);
  if (updates) updates.push(action);
  else frame.renderPhaseUpdates.set(key, [action]);
};

const areDependenciesEqual = (
  previousDependencies: readonly unknown[] | undefined,
  nextDependencies: readonly unknown[] | undefined,
): boolean => {
  if (!previousDependencies || !nextDependencies) return false;
  if (previousDependencies.length !== nextDependencies.length) return false;
  return previousDependencies.every((dependency, index) =>
    Object.is(dependency, nextDependencies[index]),
  );
};

const runEffectCleanup = (cell: ConditionalEffectCell): void => {
  const cleanup = cell.cleanup;
  cell.cleanup = undefined;
  cleanup?.();
};

/**
 * Layout effects run during the observed commit, while passive effects wait for
 * a microtask to preserve React's visible ordering. The version token turns
 * every queued passive setup into a cancelable task. If a branch disappears,
 * dependencies change, or the component unmounts before that microtask runs,
 * the task sees a different cell or version and becomes a no-op.
 */
const startEffect = (
  scope: ConditionalHookScope,
  key: PropertyKey,
  cell: ConditionalEffectCell,
  create: ConditionalEffectRegistration["create"],
): void => {
  const version = ++cell.version;
  const invoke = (): void => {
    if (scope.didUnmount || scope.effects.get(key) !== cell || cell.version !== version) return;
    cell.cleanup = create() || undefined;
  };
  if (cell.kind === "layout-effect") {
    invoke();
  } else {
    queueMicrotask(invoke);
  }
};

const isStrictEffectsFiber = (fiber: Fiber): boolean => (fiber.mode & STRICT_EFFECTS_MODE) !== 0;

/**
 * Hidden trees remain mounted, so the unmount callback cannot model their
 * effect lifecycle. Suspense uses an Offscreen Fiber and disconnects layout
 * effects while preserving passive effects. Activity hidden mode disconnects
 * both. Walking ancestors on every commit mirrors those two renderer policies
 * while retaining the scope's state cells for a later reveal.
 */
const getVisibilityState = (fiber: Fiber): ConditionalVisibilityState => {
  let layoutEffectsHidden = false;
  let passiveEffectsHidden = false;
  let ancestor = fiber.return;
  while (ancestor) {
    if (ancestor.tag === OffscreenComponentTag && ancestor.memoizedState !== null) {
      layoutEffectsHidden = true;
    }
    if (
      ancestor.tag === REACT_19_ACTIVITY_COMPONENT_TAG &&
      ancestor.memoizedProps.mode === HIDDEN_SUBTREE_MODE
    ) {
      layoutEffectsHidden = true;
      passiveEffectsHidden = true;
    }
    ancestor = ancestor.return;
  }
  return { layoutEffectsHidden, passiveEffectsHidden };
};

const reconnectEffects = (scope: ConditionalHookScope, kind: ConditionalEffectKind): void => {
  for (const [key, cell] of scope.effects) {
    if (cell.kind === kind) startEffect(scope, key, cell, cell.create);
  }
};

const disconnectEffects = (scope: ConditionalHookScope, kind: ConditionalEffectKind): void => {
  for (const cell of scope.effects.values()) {
    if (cell.kind === kind) runEffectCleanup(cell);
  }
};

const updateScopeVisibility = (scope: ConditionalHookScope): void => {
  associateScopeWithFiber(scope, getCurrentFiberBranch(scope.fiber));
  const visibility = getVisibilityState(scope.fiber);
  const shouldDisconnectLayoutEffects = visibility.layoutEffectsHidden;
  const shouldDisconnectPassiveEffects = visibility.passiveEffectsHidden;

  if (shouldDisconnectLayoutEffects !== scope.layoutEffectsDisconnected) {
    scope.layoutEffectsDisconnected = shouldDisconnectLayoutEffects;
    if (shouldDisconnectLayoutEffects) disconnectEffects(scope, "layout-effect");
    else reconnectEffects(scope, "layout-effect");
  }
  if (shouldDisconnectPassiveEffects !== scope.passiveEffectsDisconnected) {
    scope.passiveEffectsDisconnected = shouldDisconnectPassiveEffects;
    if (shouldDisconnectPassiveEffects) disconnectEffects(scope, "effect");
    else reconnectEffects(scope, "effect");
  }
};

const applyRenderPhaseUpdates = (frame: ConditionalRenderFrame): boolean => {
  let didStateChange = false;
  for (const [key, actions] of frame.renderPhaseUpdates) {
    const cell = frame.cells.get(key) ?? frame.scope.cells.get(key);
    if (!cell || (cell.kind !== "state" && cell.kind !== "reducer")) continue;
    let nextValue = cell.value;
    for (const action of actions) {
      if (cell.kind === "state") {
        nextValue = typeof action === "function" ? action(nextValue) : action;
      } else {
        const reducer = frame.reducerOverrides.get(key) ?? cell.reducer;
        nextValue = reducer(nextValue, action);
      }
    }
    if (Object.is(cell.value, nextValue)) continue;
    cell.value = nextValue;
    didStateChange = true;
  }
  return didStateChange;
};

/**
 * Promotion happens only after Bippy reports that React committed this Fiber.
 * First, speculative cells and the latest reducer closures become committed
 * state. Next, effects missing from the successful render are removed. Finally,
 * changed effects are prepared in cleanup-before-create order.
 *
 * Render-phase updates intentionally trigger one more render before effects
 * start. This matches React's rerender loop: effects should observe the settled
 * state, not an intermediate render that immediately scheduled more work.
 *
 * Layout effect setup is collected for the root-level pass so every cleanup in
 * the commit finishes before any sibling setup begins. Passive setup remains
 * cancelable through startEffect's version token.
 */
const commitRenderFrame = (
  frame: ConditionalRenderFrame,
  pendingLayoutEffects: Array<[ConditionalHookScope, PropertyKey, ConditionalEffectCell]>,
  pendingStrictLayoutEffects: Array<[ConditionalHookScope, PropertyKey, ConditionalEffectCell]>,
  pendingStrictPassiveEffects: Array<[ConditionalHookScope, PropertyKey, ConditionalEffectCell]>,
): void => {
  const { effects, scope } = frame;
  scopes.add(scope);
  associateScopeWithFiber(scope, frame.fiber);
  for (const [key, kind] of frame.hookKinds) scope.hookKinds.set(key, kind);
  for (const [key, cell] of frame.cells) {
    const previousCell = scope.cells.get(key);
    if (
      previousCell?.kind === "reducer" &&
      cell.kind === "reducer" &&
      previousCell.dispatch === cell.dispatch
    ) {
      previousCell.value = cell.value;
    } else {
      scope.cells.set(key, cell);
    }
  }
  for (const [key, reducer] of frame.reducerOverrides) {
    const cell = scope.cells.get(key);
    if (cell?.kind === "reducer") {
      cell.reducer = reducer;
      const actionCount = frame.reducerActionCounts.get(key) ?? 0;
      if (actionCount > 0) cell.pendingActions.splice(0, actionCount);
    }
  }
  const isInitialCommit = !scope.didCommit;
  scope.didCommit = true;

  if (applyRenderPhaseUpdates(frame)) {
    queueMicrotask(() => scheduleScopeUpdate(scope));
    return;
  }

  for (const [key, cell] of scope.effects) {
    if (effects.has(key)) continue;
    runEffectCleanup(cell);
    scope.effects.delete(key);
  }

  const changedEffects: Array<[PropertyKey, ConditionalEffectCell]> = [];
  for (const [key, registration] of effects) {
    const previousCell = scope.effects.get(key);
    if (
      previousCell &&
      previousCell.kind === registration.kind &&
      areDependenciesEqual(previousCell.dependencies, registration.dependencies)
    ) {
      previousCell.create = registration.create;
      continue;
    }
    if (previousCell) runEffectCleanup(previousCell);
    const cell: ConditionalEffectCell = {
      cleanup: undefined,
      create: registration.create,
      dependencies: registration.dependencies,
      kind: registration.kind,
      version: previousCell?.version ?? 0,
    };
    scope.effects.set(key, cell);
    changedEffects.push([key, cell]);
  }

  const visibility = getVisibilityState(scope.fiber);
  const areLayoutEffectsHidden = visibility.layoutEffectsHidden;
  const arePassiveEffectsHidden = visibility.passiveEffectsHidden;
  for (const [key, cell] of changedEffects) {
    if (cell.kind === "layout-effect" && areLayoutEffectsHidden) continue;
    if (cell.kind === "effect" && arePassiveEffectsHidden) continue;
    if (cell.kind === "layout-effect") pendingLayoutEffects.push([scope, key, cell]);
    else startEffect(scope, key, cell, cell.create);
  }

  if (isInitialCommit && isStrictEffectsFiber(frame.fiber)) {
    const layoutEffects = areLayoutEffectsHidden
      ? []
      : changedEffects.filter(([, cell]) => cell.kind === "layout-effect");
    for (const [key, cell] of layoutEffects) {
      pendingStrictLayoutEffects.push([scope, key, cell]);
    }
    const passiveEffects = arePassiveEffectsHidden
      ? []
      : changedEffects.filter(([, cell]) => cell.kind === "effect");
    for (const [key, cell] of passiveEffects) {
      pendingStrictPassiveEffects.push([scope, key, cell]);
    }
  }
};

/**
 * Bippy gives us the committed root, not a callback per successful render frame.
 * Traversing the current tree is what separates committed work from abandoned
 * concurrent work. Frames that suspended or lost a race are absent from the
 * current tree and remain unpromoted.
 *
 * Strict Effects replay is queued after the normal commit work. Cleanups run as
 * a global phase before setups, matching React's sibling ordering instead of
 * replaying each scope independently.
 */
const commitRoot = (root: FiberRoot): void => {
  const pendingLayoutEffects: Array<[ConditionalHookScope, PropertyKey, ConditionalEffectCell]> =
    [];
  const pendingStrictLayoutEffects: Array<
    [ConditionalHookScope, PropertyKey, ConditionalEffectCell]
  > = [];
  const pendingStrictPassiveEffects: Array<
    [ConditionalHookScope, PropertyKey, ConditionalEffectCell]
  > = [];
  traverseFiber(root.current, (fiber) => {
    const frame = renderFrameByFiber.get(fiber);
    if (!frame) return;
    renderFrameByFiber.delete(fiber);
    commitRenderFrame(
      frame,
      pendingLayoutEffects,
      pendingStrictLayoutEffects,
      pendingStrictPassiveEffects,
    );
  });
  for (const [scope, key, cell] of pendingLayoutEffects) {
    startEffect(scope, key, cell, cell.create);
  }
  if (pendingStrictLayoutEffects.length > 0 || pendingStrictPassiveEffects.length > 0) {
    queueMicrotask(() => {
      for (const [, , cell] of pendingStrictLayoutEffects) runEffectCleanup(cell);
      for (const [, , cell] of pendingStrictPassiveEffects) runEffectCleanup(cell);
      for (const [scope, key, cell] of pendingStrictLayoutEffects) {
        startEffect(scope, key, cell, cell.create);
      }
      for (const [scope, key, cell] of pendingStrictPassiveEffects) {
        startEffect(scope, key, cell, cell.create);
      }
    });
  }
  for (const scope of scopes) updateScopeVisibility(scope);
};

const disposeScope = (scope: ConditionalHookScope): void => {
  if (scope.didUnmount) return;
  scope.didUnmount = true;
  for (const cell of scope.effects.values()) runEffectCleanup(cell);
  scope.effects.clear();
  scope.cells.clear();
  scope.hookKinds.clear();
  scopeByFiber.delete(scope.fiber);
  renderFrameByFiber.delete(scope.fiber);
  if (scope.fiber.alternate) {
    scopeByFiber.delete(scope.fiber.alternate);
    renderFrameByFiber.delete(scope.fiber.alternate);
  }
  scopes.delete(scope);
};

const unmountFiber = (fiber: Fiber): void => {
  const scope =
    scopeByFiber.get(fiber) ?? (fiber.alternate ? scopeByFiber.get(fiber.alternate) : undefined);
  if (scope) disposeScope(scope);
};

/**
 * Installation covers renderers that already injected into the DevTools hook
 * and renderers that arrive later. Calling this before importing ReactDOM is the
 * safest path because the injection listener then observes the renderer before
 * its first application render.
 *
 * Bippy instrumentation supplies the commit and unmount boundaries that the
 * dispatcher alone cannot see. Disposal reverses every descriptor replacement,
 * cleans mounted effects, and makes stale setters inert. A singleton installation
 * prevents two proxies from competing for the same dispatcher ref.
 */
export const installConditionalHooks = (
  options: ConditionalHooksOptions = {},
): ConditionalHooksInstallation => {
  if (installation) return installation;

  const rdtHook = getRDTHook();
  for (const renderer of [..._renderers, ...rdtHook.renderers.values()]) {
    installRenderer(renderer, options);
  }
  const unsubscribeRendererInject = onRendererInject((renderer) => {
    installRenderer(renderer, options);
  });
  const unsubscribeInstrumentation = instrument({
    name: CONDITIONAL_HOOKS_INSTRUMENTATION_NAME,
    onCommitFiberRoot: (_rendererId, root) => commitRoot(root),
    onCommitFiberUnmount: (_rendererId, fiber) => unmountFiber(fiber),
  });

  let didUnsubscribe = false;
  const unsubscribe = toUnsubscribe(() => {
    if (didUnsubscribe) return;
    didUnsubscribe = true;
    unsubscribeRendererInject();
    unsubscribeInstrumentation();
    for (const scope of scopes) disposeScope(scope);
    for (const runtime of runtimes) restoreRuntime(runtime);
    if (installation === unsubscribe) installation = null;
  });

  const installationDisposer: ConditionalHooksInstallation = Object.assign(unsubscribe, {
    supportedRenderers: runtimes.size,
  });
  Object.defineProperty(installationDisposer, "supportedRenderers", {
    configurable: true,
    get: () => runtimes.size,
  });
  installation = installationDisposer;
  return installationDisposer;
};

const ensureInstalled = (): void => {
  if (!installation) installConditionalHooks();
};

/**
 * Cell lookup always checks the transaction frame before committed scope state.
 * New cells stay speculative until commit, while existing cells keep their
 * stable dispatch function across branch exits and reentries.
 *
 * A dispatch during render is queued on the frame instead of mutating committed
 * state. A dispatch outside render updates the committed cell and schedules its
 * owning Fiber. The identity check rejects setters captured from cells that were
 * replaced or disposed, which prevents stale closures from reviving old state.
 */
const readStateCell = <State>(
  key: PropertyKey,
  initialState: State | (() => State),
): [State, ConditionalStateSetter<State>] => {
  ensureInstalled();
  const { frame, scope } = getScope();
  registerHookKind(frame, scope, key, "state");
  let cell = frame.cells.get(key) ?? scope.cells.get(key);
  if (!cell) {
    const stateCell: ConditionalStateCell = {
      dispatch: (action) => {
        if (scope.didUnmount) return;
        const renderFrame = getRenderFrameForScope(scope);
        if (renderFrame) {
          enqueueRenderPhaseUpdate(renderFrame, key, action);
          return;
        }
        if (scope.cells.get(key) !== stateCell) return;
        const nextValue = typeof action === "function" ? action(stateCell.value) : action;
        if (typeof action === "function" && (scope.fiber.mode & STRICT_LEGACY_MODE) !== 0) {
          action(stateCell.value);
        }
        if (Object.is(stateCell.value, nextValue)) return;
        stateCell.value = nextValue;
        scheduleScopeUpdate(scope);
      },
      kind: "state",
      value:
        typeof initialState === "function"
          ? Reflect.apply(initialState, undefined, [])
          : initialState,
    };
    cell = stateCell;
    frame.cells.set(key, cell);
  } else if (frame.replayedCells.delete(key) && typeof initialState === "function") {
    Reflect.apply(initialState, undefined, []);
  }
  if (cell.kind !== "state") throw new Error(`Conditional hook key ${String(key)} is not state.`);
  return [cell.value, cell.dispatch] as [State, ConditionalStateSetter<State>];
};

/**
 * Reducer dispatch stores actions rather than eagerly computing state because
 * React defines useReducer in terms of the reducer from the render that handles
 * the update. The frame records that latest closure, replays each pending action
 * exactly once, and removes only the actions promoted by a successful commit.
 * An abandoned render therefore cannot consume actions from the mounted scope.
 */
const readReducerCell = <State, Action, InitialState>(
  key: PropertyKey,
  reducer: (state: State, action: Action) => State,
  initialState: InitialState,
  initialize?: (initialState: InitialState) => State,
): [State, ConditionalReducerDispatcher<Action>] => {
  ensureInstalled();
  const { frame, scope } = getScope();
  registerHookKind(frame, scope, key, "reducer");
  let cell = frame.cells.get(key) ?? scope.cells.get(key);
  if (!cell) {
    const reducerCell: ConditionalReducerCell = {
      dispatch: (action) => {
        if (scope.didUnmount) return;
        const renderFrame = getRenderFrameForScope(scope);
        if (renderFrame) {
          enqueueRenderPhaseUpdate(renderFrame, key, action);
          return;
        }
        if (scope.cells.get(key) !== reducerCell) return;
        reducerCell.pendingActions.push(action);
        scheduleScopeUpdate(scope);
      },
      kind: "reducer",
      pendingActions: [],
      reducer: (state, action) => reducer(state as State, action as Action),
      value: initialize ? initialize(initialState) : initialState,
    };
    cell = reducerCell;
    frame.cells.set(key, cell);
  } else if (frame.replayedCells.delete(key) && initialize) {
    initialize(initialState);
  }
  if (cell.kind !== "reducer") {
    throw new Error(`Conditional hook key ${String(key)} is not a reducer.`);
  }
  const currentReducer = (state: unknown, action: unknown): unknown =>
    reducer(state as State, action as Action);
  frame.reducerOverrides.set(key, currentReducer);
  if (cell.pendingActions.length > 0) {
    let nextValue = cell.value;
    for (const action of cell.pendingActions) nextValue = currentReducer(nextValue, action);
    const renderedCell: ConditionalReducerCell = {
      ...cell,
      value: nextValue,
    };
    frame.cells.set(key, renderedCell);
    frame.reducerActionCounts.set(key, cell.pendingActions.length);
    cell = renderedCell;
  }
  return [cell.value, cell.dispatch] as [State, ConditionalReducerDispatcher<Action>];
};

const readRefCell = <Value>(key: PropertyKey, initialValue: Value): ConditionalRef<Value> => {
  ensureInstalled();
  const { frame, scope } = getScope();
  registerHookKind(frame, scope, key, "ref");
  let cell = frame.cells.get(key) ?? scope.cells.get(key);
  if (!cell) {
    cell = {
      kind: "ref",
      value: { current: initialValue },
    };
    frame.cells.set(key, cell);
  }
  if (cell.kind !== "ref") throw new Error(`Conditional hook key ${String(key)} is not a ref.`);
  return cell.value as ConditionalRef<Value>;
};

const readMemoCell = <Value>(
  key: PropertyKey,
  create: () => Value,
  dependencies?: readonly unknown[],
): Value => {
  ensureInstalled();
  const { frame, scope } = getScope();
  registerHookKind(frame, scope, key, "memo");
  const cell = frame.cells.get(key) ?? scope.cells.get(key);
  if (cell?.kind === "memo" && frame.replayedCells.delete(key)) {
    create();
    return cell.value as Value;
  }
  if (cell?.kind === "memo" && areDependenciesEqual(cell.dependencies, dependencies)) {
    return cell.value as Value;
  }
  if (cell && cell.kind !== "memo") {
    throw new Error(`Conditional hook key ${String(key)} is not memoized.`);
  }
  const value = create();
  frame.cells.set(key, {
    dependencies,
    kind: "memo",
    value,
  });
  return value;
};

const registerEffect = (
  key: PropertyKey,
  kind: ConditionalEffectKind,
  create: () => (() => void) | void,
  dependencies?: readonly unknown[],
): void => {
  ensureInstalled();
  const { frame, scope } = getScope();
  registerHookKind(frame, scope, key, kind);
  frame.effects.set(key, {
    create,
    dependencies,
    kind,
  });
};
