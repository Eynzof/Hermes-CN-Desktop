import { useEffect, useState } from "react";
import s from "./toast.module.css";

export interface ToastMessage {
  id: number;
  text: string;
  type: "info" | "success" | "error";
}

interface ToastProps {
  message: ToastMessage;
  onDismiss: (id: number) => void;
}

export function Toast({ message, onDismiss }: ToastProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const showTimer = setTimeout(() => setVisible(true), 10);
    const hideTimer = setTimeout(() => setVisible(false), 2000);
    const removeTimer = setTimeout(() => onDismiss(message.id), 2500);
    return () => {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      clearTimeout(removeTimer);
    };
  }, [message.id, onDismiss]);

  return (
    <div
      className={`${s.toast} ${visible ? s.visible : ""} ${s[message.type]}`}
      role="status"
      aria-live="polite"
    >
      {message.text}
    </div>
  );
}

interface ToastContainerProps {
  messages: ToastMessage[];
  onDismiss: (id: number) => void;
}

export function ToastContainer({ messages, onDismiss }: ToastContainerProps) {
  return (
    <div className={s.container}>
      {messages.map((msg) => (
        <Toast key={msg.id} message={msg} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
