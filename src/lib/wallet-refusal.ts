import { ReviewLineError, WALLET_NOT_READY_LINE } from '@bananapus/nana-sdk-core/review'

/** Only local acquisition failures before any wallet method are classified as unsent. */
export class WalletNotInvokedError extends ReviewLineError {
  readonly code?: 4001
  readonly walletNotInvoked = true
  constructor(readonly acquisitionCause: unknown, submission = true) {
    super(acquisitionCause instanceof ReviewLineError ? acquisitionCause.message : WALLET_NOT_READY_LINE)
    if (submission) this.code = 4001
  }
}
