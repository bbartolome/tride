import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { ApiClient } from '../../../core/api.client';
import { TerminalSummary } from '../../../core/api.types';
import { TerminalsList } from './terminals-list';

const FIXTURE: TerminalSummary[] = [
  { id: 'wui-000000000001', cwd: 'my-project', mode: 'shell', label: 'Shell 1', createdAt: 1700000000000 },
  { id: 'wui-000000000002', cwd: '', mode: 'claude', label: 'my-task', createdAt: 1700000001000 },
];

describe('TerminalsList', () => {
  let listTerminals: ReturnType<typeof vi.fn>;
  let createTerminal: ReturnType<typeof vi.fn>;
  let removeTerminal: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    listTerminals = vi.fn().mockReturnValue(of(FIXTURE));
    createTerminal = vi.fn().mockReturnValue(
      of({ id: 'wui-000000000099', cwd: 'x', mode: 'shell', label: 'x', createdAt: 0 }),
    );
    removeTerminal = vi.fn().mockReturnValue(of(undefined));

    await TestBed.configureTestingModule({
      imports: [TerminalsList],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        {
          provide: ApiClient,
          useValue: { listTerminals, createTerminal, removeTerminal } as unknown as ApiClient,
        },
      ],
    }).compileComponents();
  });

  it('calls listTerminals() on init', () => {
    TestBed.createComponent(TerminalsList);
    expect(listTerminals).toHaveBeenCalled();
  });

  it('renders one card per terminal with label, mode badge and cwd rendered verbatim', async () => {
    const fixture = TestBed.createComponent(TerminalsList);
    await fixture.whenStable();

    const cards = fixture.nativeElement.querySelectorAll('.terminal-card');
    expect(cards.length).toBe(2);
    expect(cards[0].querySelector('.label')?.textContent).toBe('Shell 1');
    expect(cards[0].querySelector('.cwd')?.textContent).toBe('my-project');
    expect(cards[0].querySelector('.badge')?.textContent?.trim()).toBe('shell');
    expect(cards[0].getAttribute('href')).toBe('/terminal/wui-000000000001');

    // Workspace-relative cwd '' (the root) is not left blank, but is not
    // "prettified" into some fabricated absolute path either.
    expect(cards[1].querySelector('.cwd')?.textContent).toBe('(workspace root)');
    expect(cards[1].querySelector('.badge.claude')).toBeTruthy();
  });

  it('shows an empty state when there are no terminals', async () => {
    listTerminals.mockReturnValue(of([]));
    const fixture = TestBed.createComponent(TerminalsList);
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('app-empty-state')).toBeTruthy();
    expect(fixture.nativeElement.querySelectorAll('.terminal-card').length).toBe(0);
  });

  it('shows an empty state with the server message on a load error', async () => {
    listTerminals.mockReturnValue(
      throwError(() => ({ status: 500, code: 'INTERNAL_ERROR', message: 'boom' })),
    );
    const fixture = TestBed.createComponent(TerminalsList);
    await fixture.whenStable();
    const message = fixture.nativeElement.querySelector('app-empty-state .message');
    expect(message?.textContent).toContain('boom');
  });

  it('rejects an invalid Claude label client-side without ever calling the API', async () => {
    const fixture = TestBed.createComponent(TerminalsList);
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    (root.querySelector('select[name="mode"]') as HTMLSelectElement).value = 'claude';
    root
      .querySelector('select[name="mode"]')!
      .dispatchEvent(new Event('change'));
    const labelInput = root.querySelector('input[name="label"]') as HTMLInputElement;
    labelInput.value = '-dangerously-skip-permissions';
    labelInput.dispatchEvent(new Event('input'));
    (root.querySelector('input[name="cwd"]') as HTMLInputElement).value = 'some-dir';
    root.querySelector('input[name="cwd"]')!.dispatchEvent(new Event('input'));

    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();

    expect(createTerminal).not.toHaveBeenCalled();
    expect(root.querySelector('.create-error')?.textContent).toContain('Label');
  });

  it('creates a terminal and navigates to it on valid submission', async () => {
    const fixture = TestBed.createComponent(TerminalsList);
    await fixture.whenStable();
    const router = TestBed.inject(Router);
    const navigateSpy = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const root = fixture.nativeElement as HTMLElement;

    (root.querySelector('input[name="cwd"]') as HTMLInputElement).value = 'some-dir';
    root.querySelector('input[name="cwd"]')!.dispatchEvent(new Event('input'));
    root.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();

    expect(createTerminal).toHaveBeenCalledWith('some-dir', { mode: 'shell', label: undefined });
    expect(navigateSpy).toHaveBeenCalledWith(['/terminal', 'wui-000000000099']);
  });

  it('delete asks for a light confirm, not the typed dialog, and reloads on confirm', async () => {
    const fixture = TestBed.createComponent(TerminalsList);
    await fixture.whenStable();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const root = fixture.nativeElement as HTMLElement;

    const deleteBtn = root.querySelector('.delete') as HTMLButtonElement;
    deleteBtn.click();
    await fixture.whenStable();
    expect(confirmSpy).toHaveBeenCalled();
    expect(removeTerminal).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    listTerminals.mockClear();
    deleteBtn.click();
    await fixture.whenStable();
    expect(removeTerminal).toHaveBeenCalledWith('wui-000000000001');
    expect(listTerminals).toHaveBeenCalled(); // reloaded after removal
  });
});
