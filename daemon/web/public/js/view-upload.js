// File picker, clipboard and drop DOM. Sends user actions to upload controller.
import { $ } from "./dom.js";
export function createUploadView(ctx) {
  const model = ctx.model, t = ctx.t;
  function openFilePicker() {
    $("file-input").click();
  }
  function showUploadStatus(name, percent) {
    $("upload-status").hidden = false;
    $("upload-status").textContent = `${t("uploading")} · ${name}${
      percent === undefined ? "" : ` ${percent}%`
    }`;
  }
  function hideUploadStatus() {
    $("upload-status").hidden = true;
  }
  function showDropOverlay(show) {
    $("drop-overlay").hidden = !show;
  }
  $("attach").addEventListener("click", () => ctx.selectFiles());
  $("file-input").addEventListener("change", (event) => {
    const files = [...event.target.files];
    event.target.value = "";
    ctx.filesChosen(files);
  });
  $("file-input").addEventListener("cancel", () => ctx.cancelFileChoice());
  $("message-input").addEventListener("paste", (event) => {
    const images = [...(event.clipboardData?.items || [])].filter((item) =>
      item.kind === "file" && item.type.startsWith("image/")
    ).map((item) => item.getAsFile()).filter(Boolean);
    if (images.length) {
      event.preventDefault();
      ctx.sendFiles(images);
    }
  });
  $("conversation").addEventListener("dragenter", (event) => {
    if (!event.dataTransfer?.types.includes("Files") || !model.active) return;
    event.preventDefault();
    ctx.dragEnter();
  });
  $("conversation").addEventListener("dragover", (event) => {
    if (event.dataTransfer?.types.includes("Files")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  });
  $("conversation").addEventListener("dragleave", (event) => {
    event.preventDefault();
    ctx.dragLeave();
  });
  $("conversation").addEventListener("drop", (event) => {
    event.preventDefault();
    ctx.dropFiles([...(event.dataTransfer?.files || [])]);
  });
  return {
    openFilePicker,
    showUploadStatus,
    hideUploadStatus,
    showDropOverlay,
  };
}
