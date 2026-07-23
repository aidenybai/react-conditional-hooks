# react-conditional-hooks

[![version](https://img.shields.io/npm/v/react-conditional-hooks?style=flat&colorA=000000&colorB=000000)](https://npmjs.com/package/react-conditional-hooks)
[![downloads](https://img.shields.io/npm/dt/react-conditional-hooks.svg?style=flat&colorA=000000&colorB=000000)](https://npmjs.com/package/react-conditional-hooks)

Use ordinary React hooks inside branches whose hook order changes between renders.

```tsx
const Counter = ({ enabled }: { enabled: boolean }) => {
  if (enabled) {
    const [count, setCount] = React.useState(0);
    return <button onClick={() => setCount(count + 1)}>{count}</button>;
  }

  return null;
};
```

This experimental library is built on [Bippy](https://github.com/aidenybai/bippy). It intercepts the active React dispatcher and stores conditional hook cells beside the owning Fiber.

> [!IMPORTANT]
> This only works with React development renderers. It relies on private renderer fields exposed to React DevTools and is not production-safe.

## Install

```bash
npm install react-conditional-hooks
```

## Usage

Install the runtime before the module that renders your application:

```tsx
import { installConditionalHooks } from "react-conditional-hooks";

const conditionalHooksInstallation = installConditionalHooks();
const { startApplication } = await import("./app.js");

startApplication();
```

The dynamic import lets the library observe the renderer before ReactDOM starts the first render. Application code continues to call ordinary React APIs:

```tsx
import React from "react";

interface ConditionalCounterProperties {
  enabled: boolean;
}

export const ConditionalCounter = ({ enabled }: ConditionalCounterProperties): React.ReactNode => {
  if (!enabled) return null;

  const [count, setCount] = React.useState(0);
  const doubledCount = React.useMemo(() => count * 2, [count]);

  React.useEffect(() => {
    console.log("conditional effect mounted");
    return () => console.log("conditional effect cleaned up");
  }, []);

  return (
    <button onClick={() => setCount((currentCount) => currentCount + 1)}>
      {count} × 2 = {doubledCount}
    </button>
  );
};
```

The runtime handles `useState`, `useReducer`, `useRef`, `useMemo`, `useCallback`, `useEffect`, and `useLayoutEffect`. Conditional state is retained when a branch disappears; conditional effects are cleaned up and restarted when the branch returns.

`installConditionalHooks()` returns a callable disposer with a live `supportedRenderers` count:

```ts
const dispose = installConditionalHooks();

console.log(dispose.supportedRenderers);
dispose();
```

An optional global key resolver can customize callsite identity:

```ts
installConditionalHooks({
  getHookKey: (hookName, stack) => `${hookName}:${stack}`,
});
```

## Development

```bash
ni
nr build
nr test
nr check
```

## License

MIT
