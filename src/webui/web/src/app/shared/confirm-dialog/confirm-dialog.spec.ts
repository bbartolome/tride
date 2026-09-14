import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ConfirmDialog } from './confirm-dialog';
import { ConfirmDialogService } from './confirm-dialog.service';

describe('ConfirmDialog', () => {
  let service: ConfirmDialogService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ConfirmDialog],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
    service = TestBed.inject(ConfirmDialogService);
  });

  function create() {
    const fixture = TestBed.createComponent(ConfirmDialog);
    return fixture;
  }

  function setInput(root: HTMLElement, value: string): HTMLInputElement {
    const input = root.querySelector('.confirm-input') as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    return input;
  }

  it('renders nothing when no dialog is open', async () => {
    const fixture = create();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.confirm-dialog')).toBeNull();
  });

  it('shows the title/body and keeps confirm disabled until the input matches exactly', async () => {
    const fixture = create();
    void service.open({ title: 'Discard changes?', body: 'This deletes stuff.', requiredText: 'discard' });
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('h2')?.textContent).toBe('Discard changes?');
    expect(root.querySelector('.body')?.textContent).toBe('This deletes stuff.');

    const confirmBtn = root.querySelector('.confirm') as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);

    setInput(root, 'disc');
    await fixture.whenStable();
    expect(confirmBtn.disabled).toBe(true);
  });

  it('is case-sensitive and whitespace-sensitive: " discard" and "Discard" both stay disabled', async () => {
    const fixture = create();
    void service.open({ title: 'Discard changes?', body: 'body', requiredText: 'discard' });
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const confirmBtn = root.querySelector('.confirm') as HTMLButtonElement;

    setInput(root, ' discard');
    await fixture.whenStable();
    expect(confirmBtn.disabled).toBe(true);

    setInput(root, 'Discard');
    await fixture.whenStable();
    expect(confirmBtn.disabled).toBe(true);

    setInput(root, 'discard ');
    await fixture.whenStable();
    expect(confirmBtn.disabled).toBe(true);
  });

  it('enables confirm only on an exact match, and resolves the open() promise true on confirm', async () => {
    const fixture = create();
    const result = service.open({ title: 't', body: 'b', requiredText: 'force push' });
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const confirmBtn = root.querySelector('.confirm') as HTMLButtonElement;

    setInput(root, 'force push');
    await fixture.whenStable();
    expect(confirmBtn.disabled).toBe(false);

    confirmBtn.click();
    await expect(result).resolves.toBe(true);
    await fixture.whenStable();
    expect(root.querySelector('.confirm-dialog')).toBeNull();
  });

  it('cancel resolves the open() promise false', async () => {
    const fixture = create();
    const result = service.open({ title: 't', body: 'b', requiredText: 'discard' });
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    (root.querySelector('.cancel') as HTMLButtonElement).click();
    await expect(result).resolves.toBe(false);
  });
});
