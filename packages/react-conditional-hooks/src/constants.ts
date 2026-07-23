export const STRICT_LEGACY_MODE = 0b0001000;
export const STRICT_EFFECTS_MODE = 0b0010000;

/**
 * React 19.2 assigns Activity Fibers tag 31. Bippy 0.6 exports the older tag
 * value 28, so importing that constant would start passive effects inside a
 * hidden Activity tree. Keep this compatibility value local until Bippy's
 * supported renderer constants match the React line exercised here.
 */
export const REACT_19_ACTIVITY_COMPONENT_TAG = 31;

export const CONDITIONAL_HOOKS_INSTRUMENTATION_NAME = "react-conditional-hooks";
export const AUTOMATIC_HOOK_KEY_PREFIX = "react";
export const CONDITIONAL_UPDATE_PROPERTY = "__reactConditionalHookUpdate";
export const HIDDEN_SUBTREE_MODE = "hidden";

export const RUNTIME_STACK_FILE_PATTERNS = [
  "/node_modules/react-conditional-hooks/dist/",
  "/react-conditional-hooks/src/runtime.",
  "/react-conditional-hooks/src/utils/get-hook-callsite-key.",
];

export const REACT_STACK_FILE_PATTERNS = [
  "/node_modules/react/",
  "/node_modules/react-dom/",
  "/node_modules/.vite/deps/react",
  "/react.development.js",
  "/react.production.js",
  "/react-dom-client.development.js",
  "/react-dom-client.production.js",
];

export const RUNTIME_STACK_FUNCTION_NAMES = ["getHookCallsiteKey", "getAutomaticHookKey"];
