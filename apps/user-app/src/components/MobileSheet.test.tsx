import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MobileSheet } from "./MobileSheet";
import { t } from "../shared/i18n";

describe("MobileSheet", () => {
  it("会渲染标题、描述和取消按钮，并支持遮罩关闭", () => {
    const onClose = vi.fn();

    render(
      <MobileSheet
        open
        title="终端操作"
        description="选择一个动作继续处理当前终端。"
        kind="action"
        height="half"
        onClose={onClose}
      >
        <button type="button">复制标签</button>
      </MobileSheet>
    );

    const dialog = screen.getByRole("dialog", { name: "终端操作" });

    expect(dialog).toHaveAttribute("data-kind", "action");
    expect(dialog).toHaveAttribute("data-height", "half");
    expect(screen.getByText("选择一个动作继续处理当前终端。")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: t("common.cancel") }));

    const overlay = document.querySelector(".mobile-sheet-overlay");

    if (!(overlay instanceof HTMLDivElement)) {
      throw new Error("未找到 mobile sheet overlay");
    }

    fireEvent.click(overlay);

    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("在不可关闭时会禁用取消按钮和遮罩关闭", () => {
    const onClose = vi.fn();

    render(
      <MobileSheet
        open
        title="处理中"
        dismissible={false}
        onClose={onClose}
      >
        <p>正文</p>
      </MobileSheet>
    );

    const cancelButton = screen.getByRole("button", { name: t("common.cancel") });
    const overlay = document.querySelector(".mobile-sheet-overlay");

    if (!(overlay instanceof HTMLDivElement)) {
      throw new Error("未找到 mobile sheet overlay");
    }

    fireEvent.click(cancelButton);
    fireEvent.click(overlay);

    expect(cancelButton).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("可以关闭背景遮罩视觉效果，但保留 sheet 壳层", () => {
    render(
      <MobileSheet
        open
        title="分配标签"
        backdropVisible={false}
        onClose={() => {}}
      >
        <p>正文</p>
      </MobileSheet>
    );

    const overlay = document.querySelector(".mobile-sheet-overlay");

    if (!(overlay instanceof HTMLDivElement)) {
      throw new Error("未找到 mobile sheet overlay");
    }

    expect(overlay.dataset.backdropVisible).toBe("false");
  });

  it("支持隐藏标题区，同时保留对话框的无障碍名称", () => {
    render(
      <MobileSheet
        open
        title="快捷短语"
        description="这里集中管理你常用的会话指令。"
        hideHeader
        onClose={() => {}}
      >
        <p>正文</p>
      </MobileSheet>
    );

    const dialog = screen.getByRole("dialog", { name: "快捷短语" });

    expect(dialog.querySelector(".mobile-sheet-header")).toBeNull();
    expect(dialog.querySelector(".mobile-sheet-title-wrap")).toBeNull();
    expect(screen.queryByText("这里集中管理你常用的会话指令。")).not.toBeInTheDocument();
    expect(screen.getByText("正文")).toBeInTheDocument();
  });

  it("支持给遮罩和卡片补业务 class，业务侧不用再手写壳层", () => {
    render(
      <MobileSheet
        open
        title="快捷短语"
        overlayClassName="demo-sheet-overlay"
        className="demo-sheet"
        cardClassName="demo-sheet-card"
        onClose={() => {}}
      >
        <p>正文</p>
      </MobileSheet>
    );

    expect(document.querySelector(".mobile-sheet-overlay.demo-sheet-overlay")).not.toBeNull();
    expect(document.querySelector(".mobile-sheet.demo-sheet")).not.toBeNull();
    expect(document.querySelector(".mobile-sheet-card.demo-sheet-card")).not.toBeNull();
  });
});
