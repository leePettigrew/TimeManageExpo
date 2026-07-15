// Workers should never see raw JSON or HTTP jargon. Map the errors that can
// actually reach the UI to plain instructions.
export function friendlyAuthError(error: unknown): string {
  const msg =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error);
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? Number((error as { status: unknown }).status)
      : undefined;

  if (/security purposes|rate limit|too many/i.test(msg)) {
    return 'Too many tries — wait a minute and go again.';
  }
  if (/network|fetch failed|failed to fetch|timeout|abort/i.test(msg)) {
    return 'No connection. Check your signal and try again.';
  }
  if (status === 500 || /error sending|sms|provider|unsupported/i.test(msg)) {
    return "We couldn't send a code to that number. Double-check it, or ask your boss to make sure you're added.";
  }
  if (/invalid.*phone|phone.*invalid/i.test(msg)) {
    return "That doesn't look like a valid mobile number.";
  }
  if (/expired|invalid.*token|otp/i.test(msg)) {
    return 'Wrong or expired code — try again.';
  }
  return 'Something went wrong — try again in a moment.';
}
