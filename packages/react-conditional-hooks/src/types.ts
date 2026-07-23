import type { Fiber, ReactRenderer, Unsubscribe } from "bippy";

export interface ConditionalHookDispatcher {
  readContext?: (...arguments_: unknown[]) => unknown;
  useCallback?: (...arguments_: unknown[]) => unknown;
  useContext?: (...arguments_: unknown[]) => unknown;
  useDebugValue?: (...arguments_: unknown[]) => unknown;
  useEffect?: (...arguments_: unknown[]) => unknown;
  useLayoutEffect?: (...arguments_: unknown[]) => unknown;
  useMemo?: (...arguments_: unknown[]) => unknown;
  useReducer?: (...arguments_: unknown[]) => unknown;
  useRef?: (...arguments_: unknown[]) => unknown;
  useState?: (...arguments_: unknown[]) => unknown;
}

export interface ConditionalHookDispatcherRef {
  H?: ConditionalHookDispatcher | null;
  current?: ConditionalHookDispatcher | null;
}

export interface ConditionalHookRuntime {
  activeFiber: Fiber | null;
  currentDispatcher: ConditionalHookDispatcher | null;
  dispatcherKey: "H" | "current";
  dispatcherRef: ConditionalHookDispatcherRef;
  getHookKey: ConditionalHookKeyResolver;
  originalDescriptor: PropertyDescriptor | undefined;
  proxyByDispatcher: WeakMap<object, ConditionalHookDispatcher>;
  renderer: ReactRenderer;
}

export interface ConditionalHookScope {
  cells: Map<PropertyKey, ConditionalHookCell>;
  didCommit: boolean;
  didUnmount: boolean;
  effects: Map<PropertyKey, ConditionalEffectCell>;
  fiber: Fiber;
  hookKinds: Map<PropertyKey, ConditionalHookKind>;
  layoutEffectsDisconnected: boolean;
  passiveEffectsDisconnected: boolean;
  renderer: ReactRenderer;
}

export interface ConditionalRenderFrame {
  callCounts: Map<PropertyKey, number>;
  cells: Map<PropertyKey, ConditionalHookCell>;
  effects: Map<PropertyKey, ConditionalEffectRegistration>;
  fiber: Fiber;
  hookKinds: Map<PropertyKey, ConditionalHookKind>;
  reducerActionCounts: Map<PropertyKey, number>;
  reducerOverrides: Map<PropertyKey, (state: unknown, action: unknown) => unknown>;
  replayedCells: Set<PropertyKey>;
  renderPhaseUpdates: Map<PropertyKey, unknown[]>;
  scope: ConditionalHookScope;
}

export interface ConditionalVisibilityState {
  layoutEffectsHidden: boolean;
  passiveEffectsHidden: boolean;
}

export interface ConditionalStateCell {
  dispatch: (action: unknown) => void;
  kind: "state";
  value: unknown;
}

export interface ConditionalReducerCell {
  dispatch: (action: unknown) => void;
  kind: "reducer";
  pendingActions: unknown[];
  reducer: (state: unknown, action: unknown) => unknown;
  value: unknown;
}

export interface ConditionalRefCell {
  kind: "ref";
  value: ConditionalRef<unknown>;
}

export interface ConditionalMemoCell {
  dependencies: readonly unknown[] | undefined;
  kind: "memo";
  value: unknown;
}

export interface ConditionalEffectCell {
  cleanup: (() => void) | undefined;
  create: ConditionalEffectRegistration["create"];
  dependencies: readonly unknown[] | undefined;
  kind: ConditionalEffectKind;
  version: number;
}

export interface ConditionalEffectRegistration {
  create: () => (() => void) | void;
  dependencies: readonly unknown[] | undefined;
  kind: ConditionalEffectKind;
}

export interface ConditionalRef<Value> {
  current: Value;
}

export interface ConditionalStateSetter<State> {
  (action: State | ((previousState: State) => State)): void;
}

export interface ConditionalReducerDispatcher<Action> {
  (action: Action): void;
}

export interface ConditionalHooksInstallation extends Unsubscribe {
  readonly supportedRenderers: number;
}

export interface ConditionalHooksOptions {
  getHookKey?: ConditionalHookKeyResolver;
}

export interface ConditionalHookKeyResolver {
  (hookName: string, stack: string): PropertyKey;
}

export interface ActiveConditionalRuntime {
  fiber: Fiber;
  runtime: ConditionalHookRuntime;
}

export interface ActiveConditionalScope {
  frame: ConditionalRenderFrame;
  scope: ConditionalHookScope;
}

export type ConditionalHookCell =
  | ConditionalMemoCell
  | ConditionalReducerCell
  | ConditionalRefCell
  | ConditionalStateCell;

export type ConditionalEffectKind = "effect" | "layout-effect";

export type ConditionalHookKind = ConditionalHookCell["kind"] | ConditionalEffectKind;
