import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { EmptyState } from './empty-state';

describe('EmptyState', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [EmptyState],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
  });

  it('renders the message and no retry button when retry is not provided', async () => {
    const fixture = TestBed.createComponent(EmptyState);
    fixture.componentRef.setInput('message', 'Nothing here.');
    await fixture.whenStable();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.message')?.textContent).toBe('Nothing here.');
    expect(root.querySelector('.retry')).toBeNull();
  });

  it('renders a retry button with the default label and invokes the callback on click', async () => {
    const fixture = TestBed.createComponent(EmptyState);
    const retry = vi.fn();
    fixture.componentRef.setInput('message', 'Failed to load.');
    fixture.componentRef.setInput('retry', retry);
    await fixture.whenStable();

    const root = fixture.nativeElement as HTMLElement;
    const button = root.querySelector('.retry') as HTMLButtonElement;
    expect(button.textContent?.trim()).toBe('Retry');

    button.click();
    await fixture.whenStable();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('renders a custom retry label when provided', async () => {
    const fixture = TestBed.createComponent(EmptyState);
    fixture.componentRef.setInput('message', 'Failed to load.');
    fixture.componentRef.setInput('retry', vi.fn());
    fixture.componentRef.setInput('retryLabel', 'Try again');
    await fixture.whenStable();

    const root = fixture.nativeElement as HTMLElement;
    expect((root.querySelector('.retry') as HTMLButtonElement).textContent?.trim()).toBe(
      'Try again',
    );
  });
});
