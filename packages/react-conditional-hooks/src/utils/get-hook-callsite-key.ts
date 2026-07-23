import { normalizeFileName, parseStack, type StackFrame } from "bippy/source";

import {
  REACT_STACK_FILE_PATTERNS,
  RUNTIME_STACK_FILE_PATTERNS,
  RUNTIME_STACK_FUNCTION_NAMES,
} from "../constants.js";
import type { ConditionalHookKeyResolver } from "../types.js";

const normalizeStackFileName = (fileName: string): string =>
  normalizeFileName(fileName).replaceAll("\\", "/");

const isRuntimeStackFrame = (stackFrame: StackFrame): boolean => {
  const normalizedFileName = stackFrame.fileName ? normalizeStackFileName(stackFrame.fileName) : "";
  const functionName = stackFrame.functionName ?? "";

  return (
    RUNTIME_STACK_FILE_PATTERNS.some((pattern) => normalizedFileName.includes(pattern)) ||
    RUNTIME_STACK_FUNCTION_NAMES.some((name) => functionName.includes(name))
  );
};

const isReactStackFrame = (stackFrame: StackFrame): boolean => {
  if (!stackFrame.fileName) return false;
  const normalizedFileName = normalizeStackFileName(stackFrame.fileName);
  return REACT_STACK_FILE_PATTERNS.some((pattern) => normalizedFileName.includes(pattern));
};

const getStackFrameLocation = (stackFrame: StackFrame): string | null => {
  if (!stackFrame.fileName) return null;
  const normalizedFileName = normalizeStackFileName(stackFrame.fileName);
  if (!normalizedFileName) return null;

  const lineNumber = stackFrame.lineNumber === undefined ? "?" : String(stackFrame.lineNumber);
  const columnNumber =
    stackFrame.columnNumber === undefined ? "?" : String(stackFrame.columnNumber);

  return `${normalizedFileName}:${lineNumber}:${columnNumber}`;
};

/**
 * Hook identity must survive the browser-specific formatting differences in
 * Error.stack. Bippy parses V8, Firefox, and Safari frames into one structure,
 * then this resolver removes frames owned by React and this runtime. The first
 * remaining source location is the application callsite. Line and column are
 * both retained because two hooks can legally share one source line.
 */
export const getHookCallsiteKey: ConditionalHookKeyResolver = (hookName, stack) => {
  const applicationStackFrame = parseStack(stack, {
    includeInElement: false,
  }).find(
    (stackFrame) =>
      Boolean(stackFrame.fileName) &&
      stackFrame.isIgnoreListed !== true &&
      !isRuntimeStackFrame(stackFrame) &&
      !isReactStackFrame(stackFrame),
  );
  const callsiteLocation = applicationStackFrame
    ? getStackFrameLocation(applicationStackFrame)
    : null;

  if (!callsiteLocation) {
    throw new Error(`Could not derive a callsite key for React.${hookName}().`);
  }

  return `${hookName}:${callsiteLocation}`;
};
