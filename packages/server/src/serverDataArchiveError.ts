export class ServerDataArchiveError extends Error {
  constructor(
    readonly code: string,
    options?: ErrorOptions
  ) {
    super(code, options);
    this.name = "ServerDataArchiveError";
  }
}
