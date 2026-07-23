> [!WARNING]
> ⚠️⚠️⚠️ **this project may break production apps and cause unexpected behavior** ⚠️⚠️⚠️
>
> this project uses react internals, which can change at any time. we don't recommend depending on internals unless you really, _really_ have to. by proceeding, you acknowledge the risk of breaking your own code or apps that use your code.

# react-conditional-hooks

Run conditional hooks in React (experiment)

## Install

Install the package with your project’s package manager:

```bash
npm install react-conditional-hooks
```

## Use hooks inside a conditional branch

This app puts `useState` and `useMemo` inside a conditional branch:

```tsx
import { installConditionalHooks } from "react-conditional-hooks";
import { useMemo, useState, type ReactNode } from "react";

installConditionalHooks();

export const App = (): ReactNode => {
  const [isPartyMode, setIsPartyMode] = useState(false);

  if (!isPartyMode) {
    return <button onClick={() => setIsPartyMode(true)}>Start party</button>;
  }

  const [ducks, setDucks] = useState(3);
  const danceFloor = useMemo(() => "🦆".repeat(ducks), [ducks]);
  return (
    <section>
      <p>{danceFloor}</p>
      <button onClick={() => setDucks(ducks + 1)}>Add duck</button>
      <button onClick={() => setIsPartyMode(false)}>Stop party</button>
    </section>
  );
};
```

The conditional `ducks` state persists when party mode turns off and on.

## How conditional hooks work

[Bippy](https://github.com/aidenybai/bippy) is a toolkit for instrumenting React internals. This runtime uses Bippy to access renderers and commit events, then identifies hooks by source callsite and stores their state beside the component Fiber.

### React sends hook calls through a dispatcher

Functions such as `useState` delegate to React’s current dispatcher. The runtime replaces the dispatcher property with a proxy and redirects supported hooks:

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
