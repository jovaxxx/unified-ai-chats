/** Errors every connector distinguishes. Sync decides what to do from the class. */
export class SessionExpired extends Error {
  override name = 'SessionExpired';
}
export class RateLimited extends Error {
  override name = 'RateLimited';
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}
/** A response (or file) no longer matches the schema we validated against. Never guess: stop and report. */
export class EndpointChanged extends Error {
  override name = 'EndpointChanged';
}
export class NotFound extends Error {
  override name = 'NotFound';
}
