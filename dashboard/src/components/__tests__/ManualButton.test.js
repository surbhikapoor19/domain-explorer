/* Manual access button — AUTHORED BY ORCHESTRATOR (TEST AUTHOR). Implementers must NOT modify.
 * ManualButton renders a nav-link button titled "User & Architecture Manual" with the
 * visible label "Manual". Clicking it opens the statically-served HTML manual at
 * /dashboard-manual.html in a new tab via window.open(url, "_blank", "noopener"). */
import { render, screen, fireEvent } from '@testing-library/react';
import ManualButton from '../ManualButton';

test('renders a button with the manual title and visible "Manual" label', () => {
  render(<ManualButton />);
  const btn = screen.getByTitle('User & Architecture Manual');
  expect(btn).toBeInTheDocument();
  expect(btn.tagName).toBe('BUTTON');
  expect(btn).toHaveClass('nav-link');
  expect(btn).toHaveTextContent('Manual');
});

test('clicking opens /dashboard-manual.html in a new tab via window.open', () => {
  const openSpy = jest.spyOn(window, 'open').mockImplementation(() => null);

  render(<ManualButton />);
  fireEvent.click(screen.getByTitle('User & Architecture Manual'));

  expect(openSpy).toHaveBeenCalledTimes(1);
  expect(openSpy).toHaveBeenCalledWith('/dashboard-manual.html', '_blank', 'noopener');

  openSpy.mockRestore();
});
