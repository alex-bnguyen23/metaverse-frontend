import { toast, type Id, type TypeOptions } from "react-toastify";

/** Each owner updates one toast and dismisses it when its screen or controller is removed. */
export class Notification {
  private id?: Id;

  show(message: string, type: TypeOptions = "info", loading = false) {
    const options = {
      type,
      isLoading: loading,
      autoClose: loading ? (false as const) : 5000,
      closeButton: !loading,
      closeOnClick: !loading,
    };
    if (this.id !== undefined && toast.isActive(this.id))
      toast.update(this.id, { ...options, render: message });
    else this.id = toast(message, options);
  }

  dismiss() {
    if (this.id !== undefined) toast.dismiss(this.id);
    this.id = undefined;
  }
}
