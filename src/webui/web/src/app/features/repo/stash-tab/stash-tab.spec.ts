import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ApiClient } from '../../../core/api.client';
import { StashEntry } from '../../../core/api.types';
import { StashTab } from './stash-tab';

const STASHES: StashEntry[] = [
  { ref: 'stash@{0}', sha: 'aaa', date: '2024-01-01T00:00:00Z', message: 'WIP on main' },
];

describe('StashTab', () => {
  let gitStashList: ReturnType<typeof vi.fn>;
  let gitStashPush: ReturnType<typeof vi.fn>;
  let gitStashApply: ReturnType<typeof vi.fn>;
  let gitStashPop: ReturnType<typeof vi.fn>;
  let gitStashDrop: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    gitStashList = vi.fn().mockReturnValue(of(STASHES));
    gitStashPush = vi.fn().mockReturnValue(of({ ok: true }));
    gitStashApply = vi.fn().mockReturnValue(of({ ok: true }));
    gitStashPop = vi.fn().mockReturnValue(of({ ok: true }));
    gitStashDrop = vi.fn().mockReturnValue(of({ ok: true }));
    await TestBed.configureTestingModule({
      imports: [StashTab],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: ApiClient,
          useValue: {
            gitStashList,
            gitStashPush,
            gitStashApply,
            gitStashPop,
            gitStashDrop,
          } as unknown as ApiClient,
        },
      ],
    }).compileComponents();
  });

  function create(repo = 'my-repo') {
    const fixture = TestBed.createComponent(StashTab);
    fixture.componentRef.setInput('repo', repo);
    return fixture;
  }

  it('calls gitStashList(repo) and renders entries', async () => {
    const fixture = create('my-repo');
    await fixture.whenStable();
    expect(gitStashList).toHaveBeenCalledWith('my-repo');
    expect(fixture.nativeElement.querySelectorAll('.stash-row').length).toBe(1);
  });

  it('shows an empty state when there are no stash entries', async () => {
    gitStashList.mockReturnValue(of([]));
    const fixture = create();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('app-empty-state')).toBeTruthy();
  });

  it('push sends the message and includeUntracked flag it was given', async () => {
    const fixture = create('my-repo');
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    const messageInput = root.querySelector('#stash-message') as HTMLInputElement;
    messageInput.value = 'wip';
    messageInput.dispatchEvent(new Event('input'));
    const checkbox = root.querySelector('.checkbox input') as HTMLInputElement;
    checkbox.click();
    await fixture.whenStable();

    (root.querySelector('.push-form button') as HTMLButtonElement).click();
    await fixture.whenStable();

    expect(gitStashPush).toHaveBeenCalledWith('my-repo', {
      message: 'wip',
      includeUntracked: true,
    });
  });

  it('push with a blank message sends undefined, not an empty string', async () => {
    const fixture = create('my-repo');
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    (root.querySelector('.push-form button') as HTMLButtonElement).click();
    await fixture.whenStable();

    expect(gitStashPush).toHaveBeenCalledWith('my-repo', {
      message: undefined,
      includeUntracked: false,
    });
  });

  it('apply/pop/drop call the matching API method with the stash ref', async () => {
    const fixture = create('my-repo');
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;

    const buttons = Array.from(root.querySelectorAll('.stash-actions button'));
    (buttons.find((b) => b.textContent?.trim() === 'Apply') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(gitStashApply).toHaveBeenCalledWith('my-repo', 'stash@{0}');

    (buttons.find((b) => b.textContent?.trim() === 'Pop') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(gitStashPop).toHaveBeenCalledWith('my-repo', 'stash@{0}');

    (buttons.find((b) => b.textContent?.trim() === 'Drop') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(gitStashDrop).toHaveBeenCalledWith('my-repo', 'stash@{0}');
  });
});
