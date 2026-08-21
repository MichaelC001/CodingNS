import { useEffect, useState, type KeyboardEvent } from "react";
import { FiCheck, FiEdit3, FiTrash2, FiX } from "react-icons/fi";

import { t } from "../../../shared/i18n";
import type { SessionQueueItemDto } from "../api/conversation-api";

interface QueuedMessageListProps {
  items: SessionQueueItemDto[];
  deletingQueueItemId?: string | null;
  updatingQueueItemId?: string | null;
  steeringQueueItemId?: string | null;
  canSteer?: boolean;
  onDelete: (queueItemId: string) => Promise<void> | void;
  onUpdate: (queueItemId: string, content: string) => Promise<void> | void;
  onSteer?: (queueItemId: string) => Promise<void> | void;
}

export function QueuedMessageList({
  items,
  deletingQueueItemId = null,
  updatingQueueItemId = null,
  steeringQueueItemId = null,
  canSteer = false,
  onDelete,
  onUpdate,
  onSteer
}: QueuedMessageListProps) {
  const [editingQueueItemId, setEditingQueueItemId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [editValidationError, setEditValidationError] = useState<string | null>(null);

  useEffect(() => {
    const editingItem = editingQueueItemId
      ? items.find((item) => item.id === editingQueueItemId) ?? null
      : null;

    if (
      editingQueueItemId
      && (
        !editingItem
        || (
          updatingQueueItemId !== editingQueueItemId
          && editingItem.status !== "queued"
          && editingItem.status !== "failed"
        )
      )
    ) {
      setEditingQueueItemId(null);
      setEditingContent("");
      setEditValidationError(null);
    }
  }, [editingQueueItemId, items, updatingQueueItemId]);

  if (items.length === 0) {
    return null;
  }

  function beginEdit(item: SessionQueueItemDto): void {
    setEditingQueueItemId(item.id);
    setEditingContent(item.content);
    setEditValidationError(null);
  }

  function cancelEdit(): void {
    setEditingQueueItemId(null);
    setEditingContent("");
    setEditValidationError(null);
  }

  async function saveEdit(queueItemId: string): Promise<void> {
    const nextContent = editingContent.trim();

    if (!nextContent) {
      setEditValidationError(t("conversation.queueEditEmpty"));
      return;
    }

    setEditValidationError(null);

    try {
      await onUpdate(queueItemId, nextContent);
      cancelEdit();
    } catch {
      // 父级负责显示网络错误，保留编辑内容便于用户继续修改。
    }
  }

  function handleEditKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, queueItemId: string): void {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
      return;
    }

    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void saveEdit(queueItemId);
    }
  }

  return (
    <section className="queued-message-list" aria-label={t("conversation.queueTitle")}>
      <div className="queued-message-list__header">
        <h2>{`${t("conversation.queueTitle")} · ${items.length}`}</h2>
      </div>
      <div className="queued-message-list__items">
        {items.map((item, index) => {
          const canChange = item.status === "queued" || item.status === "failed";
          const canSteerItem =
            canSteer &&
            typeof onSteer === "function" &&
            canChange;
          const isEditing = editingQueueItemId === item.id;
          const isUpdating = updatingQueueItemId === item.id;

          return (
            <article
              key={item.id}
              className={`queued-message-item${isEditing ? " queued-message-item--editing" : ""}`}
            >
              <div className="queued-message-item__main">
                <span className="queued-message-item__order" aria-hidden="true">
                  {index + 1}
                </span>
                {isEditing ? (
                  <textarea
                    className="queued-message-item__editor"
                    value={editingContent}
                    rows={3}
                    autoFocus
                    aria-label={t("conversation.queueEdit")}
                    onChange={(event) => {
                      setEditingContent(event.target.value);
                      setEditValidationError(null);
                    }}
                    onKeyDown={(event) => handleEditKeyDown(event, item.id)}
                  />
                ) : (
                  <p
                    className="queued-message-item__content"
                    title={item.content || t("conversation.queueImageOnly")}
                  >
                    {item.content || t("conversation.queueImageOnly")}
                  </p>
                )}
                <span
                  className={`queued-message-item__status queued-message-item__status--${item.status}`}
                >
                  {item.status === "failed"
                    ? t("conversation.queueStatusFailed")
                    : t("conversation.queueStatusQueued")}
                </span>
                <div className="queued-message-item__actions">
                  {isEditing ? (
                    <>
                      <button
                        type="button"
                        className="queued-message-item__action queued-message-item__action--save"
                        onClick={() => void saveEdit(item.id)}
                        disabled={isUpdating}
                        aria-label={t("conversation.queueSaveEdit")}
                        title={t("conversation.queueSaveEdit")}
                      >
                        <FiCheck aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="queued-message-item__action queued-message-item__action--cancel"
                        onClick={cancelEdit}
                        disabled={isUpdating}
                        aria-label={t("conversation.queueCancelEdit")}
                        title={t("conversation.queueCancelEdit")}
                      >
                        <FiX aria-hidden="true" />
                      </button>
                    </>
                  ) : (
                    <>
                      {canChange ? (
                        <button
                          type="button"
                          className="queued-message-item__action queued-message-item__action--edit"
                          onClick={() => beginEdit(item)}
                          disabled={Boolean(updatingQueueItemId)}
                          aria-label={t("conversation.queueEdit")}
                          title={t("conversation.queueEdit")}
                        >
                          <FiEdit3 aria-hidden="true" />
                        </button>
                      ) : null}
                      {canSteerItem ? (
                        <button
                          type="button"
                          className="queued-message-item__action queued-message-item__action--steer"
                          onClick={() => void onSteer(item.id)}
                          disabled={steeringQueueItemId === item.id || Boolean(updatingQueueItemId)}
                          aria-label={t("conversation.queueSteer")}
                          title={t("conversation.queueSteer")}
                        >
                          {steeringQueueItemId === item.id
                            ? t("conversation.queueSteering")
                            : t("conversation.queueSteer")}
                        </button>
                      ) : null}
                      {canChange ? (
                        <button
                          type="button"
                          className="queued-message-item__action queued-message-item__action--delete"
                          onClick={() => void onDelete(item.id)}
                          disabled={deletingQueueItemId === item.id || Boolean(updatingQueueItemId)}
                          aria-label={t("conversation.queueDelete")}
                          title={t("conversation.queueDelete")}
                        >
                          {deletingQueueItemId === item.id ? "…" : <FiTrash2 aria-hidden="true" />}
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
              {isEditing && editValidationError ? (
                <p className="queued-message-item__edit-error">{editValidationError}</p>
              ) : null}
              {!isEditing && item.errorDetail ? (
                <p className="queued-message-item__error">{item.errorDetail}</p>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
