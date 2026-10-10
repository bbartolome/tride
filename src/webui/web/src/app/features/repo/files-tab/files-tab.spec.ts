import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ApiClient } from '../../../core/api.client';
import { FilesTab } from './files-tab';

describe('FilesTab', () => {
  let fsTree: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fsTree = vi.fn().mockImplementation((path: string) =>
      of({
        path,
        entries: [
          { name: 'readme.md', type: 'file', size: 4 },
          { name: 'src', type: 'dir' },
        ],
      }),
    );
    await TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), { provide: ApiClient, useValue: { fsTree } }],
    }).compileComponents();
  });

  it('lists the repo root, then navigates into a subdirectory and back', async () => {
    const fixture = TestBed.createComponent(FilesTab);
    fixture.componentRef.setInput('repo', 'a/my-repo');
    await fixture.whenStable();
    expect(fsTree).toHaveBeenCalledWith('a/my-repo');

    const root = fixture.nativeElement as HTMLElement;
    const names = Array.from(root.querySelectorAll('.entry .name')).map((e) => e.textContent);
    expect(names).toEqual(['src', 'readme.md']);

    (root.querySelector('button.entry-main') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(fsTree).toHaveBeenCalledWith('a/my-repo/src');

    (root.querySelector('button.crumb') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(fsTree).toHaveBeenLastCalledWith('a/my-repo');
  });
});
