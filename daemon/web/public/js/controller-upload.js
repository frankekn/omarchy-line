// Browser file upload and retry state. Uses the shared model and injected view
// actions.
export function createUploadController(ctx) {
  const model = ctx.model, t = ctx.t;
  function uploadFile(file, progress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(
        "POST",
        `/api/upload?name=${encodeURIComponent(file.name || "image.png")}`,
      );
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) {
          progress(Math.floor(event.loaded / event.total * 100));
        }
      });
      xhr.addEventListener("load", () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(`${t("uploadFailed")} (${xhr.status})`));
          return;
        }
        try {
          const data = JSON.parse(xhr.responseText);
          if (!data.path) throw new Error();
          resolve(String(data.path));
        } catch {
          reject(new Error(t("uploadFailed")));
        }
      });
      xhr.addEventListener("error", () => reject(new Error(t("uploadFailed"))));
      xhr.addEventListener("abort", () => reject(new Error(t("uploadFailed"))));
      xhr.send(file);
    });
  }
  async function sendFiles(files, retry = null) {
    const chat = retry?.chat || model.active, account = model.account;
    if (!chat || !model.connected) {
      ctx.toast(t("offlineAction"));
      return;
    }
    for (const file of files) {
      if (file.size > 1073741824) {
        ctx.toast(`${file.name}: ${t("tooLarge")}`);
        continue;
      }
      model.uploadCount++;
      ctx.showUploadStatus(file.name);
      try {
        const path = await uploadFile(
          file,
          (percent) => ctx.showUploadStatus(file.name, percent),
        );
        if (model.account !== account) throw new Error(t("offlineAction"));
        const type = file.type.startsWith("image/")
          ? "IMAGE"
          : file.type.startsWith("video/")
          ? "VIDEO"
          : "FILE";
        if (retry) {
          ctx.forgetPending(chat, retry.requestId);
          if (model.active === chat) {
            model.messages = model.messages.filter((m) =>
              !(m.pending && m.requestId === retry.requestId)
            );
          }
        }
        const message = ctx.optimistic(chat, "sendFile", { path }, {
          contentType: type,
          text: file.name,
          fileName: file.name,
          fileSize: file.size,
        });
        model.files.set(message.requestId, file);
        ctx.sendOptimistic(chat, message);
      } catch (error) {
        ctx.displayError(error);
      } finally {
        model.uploadCount--;
        if (!model.uploadCount) ctx.hideUploadStatus();
      }
    }
  }
  function selectFiles() {
    model.retryFile = null;
    ctx.openFilePicker();
  }
  function filesChosen(files) {
    const retry = model.retryFile;
    model.retryFile = null;
    if (files.length) sendFiles(retry ? files.slice(0, 1) : files, retry);
  }
  function cancelFileChoice() {
    model.retryFile = null;
  }
  function dragEnter() {
    model.dragDepth++;
    ctx.showDropOverlay(true);
  }
  function dragLeave() {
    model.dragDepth = Math.max(0, model.dragDepth - 1);
    if (!model.dragDepth) ctx.showDropOverlay(false);
  }
  function dropFiles(files) {
    model.dragDepth = 0;
    ctx.showDropOverlay(false);
    if (files.length) sendFiles(files);
  }
  return {
    sendFiles,
    selectFiles,
    filesChosen,
    cancelFileChoice,
    dragEnter,
    dragLeave,
    dropFiles,
  };
}
