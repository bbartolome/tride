import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ConfirmDialogService } from './confirm-dialog.service';

/**
 * The one rendered instance of the typed-confirmation dialog, mounted once
 * at the app root and driven entirely by `ConfirmDialogService`'s signals
 * — see that service for the `open()` API every feature calls.
 *
 * The confirm button stays disabled until the input EXACTLY equals
 * `requiredText` (`ConfirmDialogService.canConfirm`, `===`, no trim/case
 * folding) — this is the one behavior every call site depends on, since a
 * looser match here would let the UI "confirm" something the server then
 * rejects with 400 CONFIRMATION_REQUIRED.
 */
@Component({
  selector: 'app-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  templateUrl: './confirm-dialog.html',
  styleUrl: './confirm-dialog.scss',
})
export class ConfirmDialog {
  protected readonly dialog = inject(ConfirmDialogService);
}
