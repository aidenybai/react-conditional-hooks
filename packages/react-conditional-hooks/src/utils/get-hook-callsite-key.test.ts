import { describe, expect, it } from "vite-plus/test";

import { getHookCallsiteKey } from "./get-hook-callsite-key.js";

describe("getHookCallsiteKey", () => {
  it("parses a V8 application frame after runtime and React frames", () => {
    const stack = `Error
    at getHookCallsiteKey (/workspace/react-conditional-hooks/packages/react-conditional-hooks/src/utils/get-hook-callsite-key.ts:52:29)
    at getAutomaticHookKey (/workspace/react-conditional-hooks/packages/react-conditional-hooks/src/runtime.ts:112:23)
    at Object.useState (/workspace/node_modules/react/cjs/react.development.js:1500:34)
    at ConditionalCounter (http://localhost:5173/src/conditional-counter.tsx?t=123:12:24)`;

    expect(getHookCallsiteKey("useState", stack)).toBe(
      "useState:/src/conditional-counter.tsx:12:24",
    );
  });

  it("parses Firefox and Safari application frames", () => {
    const stack = `getHookCallsiteKey@http://localhost:5173/node_modules/.vite/deps/react-conditional-hooks.js?v=123:52:29
getAutomaticHookKey@http://localhost:5173/node_modules/.vite/deps/react-conditional-hooks.js?v=123:112:23
useEffect@http://localhost:5173/node_modules/.vite/deps/react.js?v=123:1500:34
ConditionalCounter@http://localhost:5173/src/conditional-counter.tsx?t=123:18:9`;

    expect(getHookCallsiteKey("useEffect", stack)).toBe(
      "useEffect:/src/conditional-counter.tsx:18:9",
    );
  });

  it("does not reject application paths containing the package name", () => {
    const stack = `Error
    at getAutomaticHookKey (/workspace/react-conditional-hooks/packages/react-conditional-hooks/src/runtime.ts:112:23)
    at Object.useMemo (/workspace/node_modules/react/cjs/react.development.js:1500:34)
    at Example (/workspace/react-conditional-hooks/examples/basic/src/example.tsx:7:17)`;

    expect(getHookCallsiteKey("useMemo", stack)).toBe(
      "useMemo:/workspace/react-conditional-hooks/examples/basic/src/example.tsx:7:17",
    );
  });

  it("uses columns to distinguish hooks on one source line", () => {
    const firstStack = `Error
    at getAutomaticHookKey (/workspace/react-conditional-hooks/packages/react-conditional-hooks/src/runtime.ts:112:23)
    at Component (/workspace/app.tsx:4:19)`;
    const secondStack = `Error
    at getAutomaticHookKey (/workspace/react-conditional-hooks/packages/react-conditional-hooks/src/runtime.ts:112:23)
    at Component (/workspace/app.tsx:4:43)`;

    expect(getHookCallsiteKey("useState", firstStack)).not.toBe(
      getHookCallsiteKey("useState", secondStack),
    );
  });

  it("fails when no application source frame exists", () => {
    const stack = `Error
    at getAutomaticHookKey (/workspace/react-conditional-hooks/packages/react-conditional-hooks/src/runtime.ts:112:23)
    at Object.useState (/workspace/node_modules/react/cjs/react.development.js:1500:34)`;

    expect(() => getHookCallsiteKey("useState", stack)).toThrow(
      "Could not derive a callsite key for React.useState().",
    );
  });
});
