import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { t } from "../../../shared/i18n";
import { resolveRenderedMarkdownContent } from "../markdown-truncation";

interface MarkdownTextProps {
  content: string;
  className: string;
  paragraphClassName?: string;
  inline?: boolean;
}

/**
 * 超长正文的「展开全文 / 收起」入口。
 *
 * 样式沿用消息里已有的内联折叠按钮基线，不再单独长一套按钮皮肤。
 */
export function MarkdownTruncationNotice({
  expanded,
  onToggle
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="markdown-truncation">
      <span className="markdown-truncation-notice">
        {t("conversation.longContentTruncatedNotice")}
      </span>
      <button
        type="button"
        className="markdown-truncation-toggle"
        aria-expanded={expanded}
        title={t(
          expanded
            ? "conversation.longContentCollapseAction"
            : "conversation.longContentExpandAction"
        )}
        onClick={onToggle}
      >
        {t(
          expanded
            ? "conversation.longContentCollapseAction"
            : "conversation.longContentExpandAction"
        )}
      </button>
    </div>
  );
}

export function MarkdownText({
  content,
  className,
  paragraphClassName,
  inline = false
}: MarkdownTextProps) {
  const [expanded, setExpanded] = useState(false);
  const renderedContent = resolveRenderedMarkdownContent(content, {
    expanded,
    disabled: inline
  });
  const RootTag = inline ? "span" : "div";

  return (
    <RootTag className={className}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ node, className: _className, ...props }) => (
            inline ? (
              <span
                {...props}
                className={paragraphClassName}
              />
            ) : (
              <p
                {...props}
                className={paragraphClassName}
              />
            )
          ),
          ...(inline
            ? {
                ul: ({ node, className: _className, ...props }) => (
                  <span {...props} />
                ),
                ol: ({ node, className: _className, ...props }) => (
                  <span {...props} />
                ),
                li: ({ node, className: _className, children, ...props }) => (
                  <span {...props}>{children}</span>
                )
              }
            : {})
        }}
      >
        {renderedContent.content}
      </Markdown>
      {renderedContent.isLong ? (
        <MarkdownTruncationNotice
          expanded={!renderedContent.isCollapsed}
          onToggle={() => setExpanded((current) => !current)}
        />
      ) : null}
    </RootTag>
  );
}
