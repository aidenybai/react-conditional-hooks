# react-conditional-hooks

[![version](https://img.shields.io/npm/v/react-conditional-hooks?style=flat&colorA=000000&colorB=000000)](https://npmjs.com/package/react-conditional-hooks)
[![downloads](https://img.shields.io/npm/dt/react-conditional-hooks.svg?style=flat&colorA=000000&colorB=000000)](https://npmjs.com/package/react-conditional-hooks)

> [!WARNING]
> ⚠️⚠️⚠️ **this project may break production apps and cause unexpected behavior** ⚠️⚠️⚠️
>
> this project uses react internals, which can change at any time. we don't recommend depending on internals unless you really, _really_ have to. by proceeding, you acknowledge the risk of breaking your own code or apps that use your code.

Call ordinary React hooks inside conditions without losing their state when the branch disappears. This experimental library replaces hook order with source callsites as hook identity.

> [!IMPORTANT]
> This library only works with React development renderers. It depends on private fields exposed to React DevTools and isn’t production-safe.

## Install

Install the package with your project’s package manager:

```bash
ni react-conditional-hooks
```

## Use hooks inside a conditional branch

This goblin portal puts `useState` and `useMemo` inside an `if` block:

```tsx
import * as React from "react";
import { installConditionalHooks } from "react-conditional-hooks";

installConditionalHooks();

export const GoblinPortal = (): React.ReactNode => {
  const [isOpen, setIsOpen] = React.useState(false);

  if (!isOpen) {
    return <button onClick={() => setIsOpen(true)}>Open goblin portal</button>;
  }

  const [goblins, setGoblins] = React.useState(3);
  const tribute = React.useMemo(() => "🥔".repeat(goblins), [goblins]);
  return (
    <section>
      <p>{tribute} for the goblin council</p>
      <button onClick={() => setGoblins(goblins + 1)}>Add goblin</button>
      <button onClick={() => setIsOpen(false)}>Close portal</button>
    </section>
  );
};
```

Open the portal, add a goblin, close it, and reopen it. The conditional `goblins` state resumes at its previous value. React normally rejects this pattern because the number of hooks changes between renders.

The runtime supports:

- **State**: `useState`, `useReducer`, and `useRef`
- **Memoization**: `useMemo` and `useCallback`
- **Effects**: `useEffect` and `useLayoutEffect`

`useContext` continues through React’s dispatcher because context lookup belongs to the renderer.

## How conditional hooks work

The runtime intercepts React’s dispatcher, derives an identity from each hook’s source location, and stores state beside the component Fiber. Bippy supplies renderer access and commit lifecycle events.

### React sends hook calls through a dispatcher

Functions such as `React.useState` delegate to React’s current dispatcher. The runtime replaces the dispatcher property with a proxy and redirects supported hooks:

```ts
const proxy = new Proxy(dispatcher, {
  get: (target, property, receiver) => {
    if (property === "useState") {
      return (initialState: unknown) =>
        readStateCell(getAutomaticHookKey(runtime, "useState"), initialState);
    }

    return Reflect.get(target, property, receiver);
  },
});
```

Application code still calls React’s APIs. Unsupported hooks pass through to the original dispatcher.

### The source callsite identifies each hook

React normally identifies a hook by its position in the component’s hook list. This runtime captures an error stack and uses Bippy to parse V8, Firefox, and Safari stack formats:

```ts
const applicationFrame = parseStack(stack).find(
  (stackFrame) =>
    Boolean(stackFrame.fileName) &&
    !isRuntimeStackFrame(stackFrame) &&
    !isReactStackFrame(stackFrame),
);

if (!applicationFrame?.fileName) throw new Error("Missing callsite");

const callsiteKey = [
  applicationFrame.fileName,
  applicationFrame.lineNumber,
  applicationFrame.columnNumber,
].join(":");
```

The file, line, and column form the stable identity. A per-render occurrence counter separates repeated calls from the same callsite.

### Each Fiber owns a committed scope

React creates a Fiber for each mounted component instance. The runtime associates that Fiber with a side table instead of modifying React’s private hook list:

```ts
interface ConditionalHookScope {
  cells: Map<PropertyKey, ConditionalHookCell>;
  effects: Map<PropertyKey, ConditionalEffectCell>;
  fiber: Fiber;
}

const scopeByFiber = new WeakMap<Fiber, ConditionalHookScope>();
const renderFrameByFiber = new WeakMap<Fiber, ConditionalRenderFrame>();
```

Hook calls write into a temporary render frame. A successful commit promotes that frame into the Fiber’s scope. Suspended, failed, or abandoned renders never change committed state.

### Commits control effect cleanup

Each successful render records the effects whose branches ran. The commit removes effects that disappeared from the next render:

```ts
for (const [key, effectCell] of scope.effects) {
  if (nextEffects.has(key)) continue;

  runEffectCleanup(effectCell);
  scope.effects.delete(key);
}
```

State cells remain in the scope when their branch disappears. Effects clean up when the branch exits and start again when it returns.

## Development

Run the package checks from the repository root:

```bash
ni
nr build
nr test
nr check
```

## License

MIT
