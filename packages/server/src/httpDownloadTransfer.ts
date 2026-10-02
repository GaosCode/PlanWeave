import { finished, type Readable, type Writable } from "node:stream";

/** Release an opened source that has not been handed to the response. */
export function releaseHttpDownloadSource(source: Readable): void {
  if (source.closed) return;
  const cleanup = finished(source, () => cleanup());
  source.destroy();
}

/** Own both ends of an authorized download until their terminal events. */
export function transferHttpDownload(source: Readable, response: Writable): void {
  let terminated = false;
  const terminate = () => {
    if (terminated) return;
    terminated = true;
    source.destroy();
    response.destroy();
  };
  const sourceClose = () => {
    source.off("error", terminate);
    source.off("close", sourceClose);
    if (!source.readableEnded) terminate();
  };
  const responseFinish = () => {
    if (terminated) return;
    terminated = true;
    source.destroy();
  };
  const responseClose = () => {
    source.unpipe(response);
    terminate();
    response.off("finish", responseFinish);
    response.off("error", terminate);
    response.off("close", responseClose);
  };
  source.on("error", terminate);
  source.once("close", sourceClose);
  response.on("error", terminate);
  response.once("finish", responseFinish);
  response.once("close", responseClose);

  if (response.destroyed || response.writableEnded || source.destroyed) {
    if (response.writableFinished) responseFinish();
    else terminate();
    if (source.closed) sourceClose();
    if (response.closed) responseClose();
    return;
  }
  try {
    source.pipe(response);
  } catch (error) {
    source.unpipe(response);
    terminate();
    throw error;
  }
}
