import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import {
  useButlerRuntimeStore,
  type ButlerRuntimeState,
  type ButlerRuntimeStore
} from "./butler-runtime-store";

function createTestStore(initialValue: number) {
  let state = { value: initialValue };
  const listeners = new Set<() => void>();

  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setValue: (value: number) => {
      state = { value };
      for (const listener of listeners) {
        listener();
      }
    }
  } as unknown as ButlerRuntimeStore & {
    setValue: (value: number) => void;
  };
}

describe("useButlerRuntimeStore", () => {
  it("不会因为内联 selector 在父组件刷新时触发更新深度循环", () => {
    const store = createTestStore(1);

    function Probe() {
      const [parentRenderVersion, setParentRenderVersion] = useState(0);
      // 故意每次渲染都返回新对象，复现旧 effect 实现的循环条件。
      const selected = useButlerRuntimeStore(store, (state) => ({
        value: (state as ButlerRuntimeState & { value: number }).value
      }));

      return (
        <div>
          <output data-testid="selected-value">{selected.value}</output>
          <output data-testid="parent-render-version">{parentRenderVersion}</output>
          <button type="button" onClick={() => setParentRenderVersion((current) => current + 1)}>
            刷新父组件
          </button>
        </div>
      );
    }

    render(<Probe />);
    expect(screen.getByTestId("selected-value")).toHaveTextContent("1");

    act(() => {
      screen.getByRole("button", { name: "刷新父组件" }).click();
    });

    expect(screen.getByTestId("parent-render-version")).toHaveTextContent("1");

    act(() => {
      store.setValue(2);
    });

    expect(screen.getByTestId("selected-value")).toHaveTextContent("2");
  });
});
