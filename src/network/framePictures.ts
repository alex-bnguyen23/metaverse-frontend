export type FrameId = "left" | "right";
export type FramePicture = {
  frameId: FrameId;
  revision: number;
  imageUrl: string | null;
  updatedAt: number | null;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Accept only versioned image paths from our API, never arbitrary remote image URLs. */
export function parseFramePicture(value: unknown): FramePicture {
  if (!record(value)) throw new Error("Invalid frame picture response.");
  const { frameId, revision, imageUrl, updatedAt } = value;
  if (
    (frameId !== "left" && frameId !== "right") ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    (revision === 0
      ? imageUrl !== null || updatedAt !== null
      : imageUrl !== `/api/frame-pictures/${frameId}/images/${revision}.jpg` ||
        typeof updatedAt !== "number" ||
        !Number.isSafeInteger(updatedAt) ||
        updatedAt < 0)
  )
    throw new Error("Invalid frame picture response.");
  return {
    frameId,
    revision,
    imageUrl: imageUrl as string | null,
    updatedAt: updatedAt as number | null,
  };
}

export function parseFramePictures(value: unknown): FramePicture[] {
  if (!record(value) || !Array.isArray(value.frames) || value.frames.length !== 2)
    throw new Error("Invalid frame pictures response.");
  const frames = value.frames.map(parseFramePicture);
  if (frames[0].frameId !== "left" || frames[1].frameId !== "right")
    throw new Error("Invalid frame pictures response.");
  return frames;
}

export class FramePicturesApi {
  readonly origin: string;

  constructor(origin: string) {
    const url = new URL(origin);
    if (
      !/^https?:$/.test(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("VITE_API_URL must be an HTTP(S) origin, without a path.");
    this.origin = url.origin;
  }

  private async request(path: string, signal: AbortSignal, body?: FormData): Promise<unknown> {
    const response = await fetch(this.origin + path, {
      method: body ? "PUT" : "GET",
      body,
      signal,
      cache: "no-store",
      credentials: "omit",
    });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        record(data) && record(data.error) && typeof data.error.message === "string"
          ? data.error.message.slice(0, 300)
          : `Frame picture request failed (${response.status}).`;
      const retry = response.headers.get("Retry-After");
      throw new Error(
        message + (retry && /^\d+$/.test(retry) ? ` Try again in ${retry} seconds.` : ""),
      );
    }
    return data;
  }

  async list(signal: AbortSignal) {
    return parseFramePictures(await this.request("/api/frame-pictures", signal));
  }

  async upload(frameId: FrameId, file: File, signal: AbortSignal) {
    const body = new FormData();
    body.append("image", file);
    const data = await this.request(`/api/frame-pictures/${frameId}`, signal, body);
    const frame = parseFramePicture(record(data) ? data.frame : null);
    if (frame.frameId !== frameId || frame.revision === 0)
      throw new Error("Invalid upload response.");
    return frame;
  }
}
