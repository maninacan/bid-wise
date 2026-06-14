import { render, fireEvent } from '@testing-library/react';

import { Questionnaire } from './questionnaire';

describe('Questionnaire', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('should render successfully', () => {
    const { baseElement } = render(<Questionnaire />);
    expect(baseElement).toBeTruthy();
  });


  it('should render a card for each contractor type', () => {
    const { getAllByRole } = render(<Questionnaire />);
    expect(getAllByRole('button', { pressed: false }).length).toBe(12);
  });

  it('should allow selecting multiple contractor types', () => {
    const { getByRole } = render(<Questionnaire />);
    const plumbing = getByRole('button', { name: /plumbing/i });
    const electrical = getByRole('button', { name: /electrical/i });

    fireEvent.click(plumbing);
    fireEvent.click(electrical);

    expect(plumbing.getAttribute('aria-pressed')).toBe('true');
    expect(electrical.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(plumbing);
    expect(plumbing.getAttribute('aria-pressed')).toBe('false');
    expect(electrical.getAttribute('aria-pressed')).toBe('true');
  });

  it('should disable Next until a choice is selected', () => {
    const { getByRole } = render(<Questionnaire />);
    const next = getByRole('button', { name: /^next$/i });
    expect(next.hasAttribute('disabled')).toBe(true);

    fireEvent.click(getByRole('button', { name: /roofing/i }));
    expect(next.hasAttribute('disabled')).toBe(false);
  });

  it('should advance to the follow-up question for the selected trade', () => {
    const { getByRole, getByText } = render(<Questionnaire />);
    fireEvent.click(getByRole('button', { name: /roofing/i }));
    fireEvent.click(getByRole('button', { name: /^next$/i }));

    expect(getByText(/what roofing system/i)).toBeTruthy();
    expect(getByText(/select all that apply/i)).toBeTruthy();
  });

  it('should produce a result for each selection on follow-up questions', () => {
    const { getByRole, getByText } = render(<Questionnaire />);
    fireEvent.click(getByRole('button', { name: /roofing/i }));
    fireEvent.click(getByRole('button', { name: /^next$/i }));

    fireEvent.click(getByRole('button', { name: /asphalt shingle/i }));
    fireEvent.click(getByRole('button', { name: /metal/i }));
    fireEvent.click(getByRole('button', { name: /^next$/i }));

    expect(getByText('Roofing — Asphalt Shingle')).toBeTruthy();
    expect(
      getByText('Roofing — Metal (Standing Seam or Exposed Fastener)'),
    ).toBeTruthy();
  });

  it('should walk every selected branch and show all results', () => {
    const { getByRole, getByText } = render(<Questionnaire />);

    fireEvent.click(getByRole('button', { name: /plumbing/i }));
    fireEvent.click(getByRole('button', { name: /electrical/i }));
    fireEvent.click(getByRole('button', { name: /^next$/i }));

    expect(getByText(/type of plumbing work/i)).toBeTruthy();
    fireEvent.click(getByRole('button', { name: /service & repair/i }));
    fireEvent.click(getByRole('button', { name: /^next$/i }));

    expect(getByText(/type of electrical work/i)).toBeTruthy();
    fireEvent.click(getByRole('button', { name: /remodel \/ addition/i }));
    fireEvent.click(getByRole('button', { name: /^next$/i }));

    expect(getByText(/your bid profiles/i)).toBeTruthy();
    expect(getByText('Plumbing — Service & Repair')).toBeTruthy();
    expect(getByText('Electrical — Remodel / Addition')).toBeTruthy();
  });

  it('should save responses to local storage on next', () => {
    const { getByRole } = render(<Questionnaire />);

    fireEvent.click(getByRole('button', { name: /plumbing/i }));
    fireEvent.click(getByRole('button', { name: /electrical/i }));
    fireEvent.click(getByRole('button', { name: /^next$/i }));

    let stored = JSON.parse(
      localStorage.getItem('bid-wise:questionnaire-responses') ?? '{}',
    );
    expect(stored['contractor-type']).toEqual(['plumbing', 'electrical']);

    fireEvent.click(getByRole('button', { name: /service & repair/i }));
    fireEvent.click(getByRole('button', { name: /^next$/i }));

    stored = JSON.parse(
      localStorage.getItem('bid-wise:questionnaire-responses') ?? '{}',
    );
    expect(stored['contractor-type']).toEqual(['plumbing', 'electrical']);
    expect(stored['plumbing-work-type']).toEqual(['service']);
  });

  it('should not show a back button on the first question', () => {
    const { queryByRole } = render(<Questionnaire />);
    expect(queryByRole('button', { name: /^back$/i })).toBeNull();
  });

  it('should return to the previous question with its selection on back', () => {
    const { getByRole, getByText } = render(<Questionnaire />);

    fireEvent.click(getByRole('button', { name: /roofing/i }));
    fireEvent.click(getByRole('button', { name: /^next$/i }));
    expect(getByText(/what roofing system/i)).toBeTruthy();

    fireEvent.click(getByRole('button', { name: /^back$/i }));
    expect(getByText(/what best describes your trade/i)).toBeTruthy();
    expect(
      getByRole('button', { name: /roofing/i }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('should go back from the results screen to the last question', () => {
    const { getByRole, getByText } = render(<Questionnaire />);

    fireEvent.click(getByRole('button', { name: /roofing/i }));
    fireEvent.click(getByRole('button', { name: /^next$/i }));
    fireEvent.click(getByRole('button', { name: /asphalt shingle/i }));
    fireEvent.click(getByRole('button', { name: /^next$/i }));
    expect(getByText('Roofing — Asphalt Shingle')).toBeTruthy();

    fireEvent.click(getByRole('button', { name: /^back$/i }));
    expect(getByText(/what roofing system/i)).toBeTruthy();
    expect(
      getByRole('button', { name: /asphalt shingle/i }).getAttribute(
        'aria-pressed',
      ),
    ).toBe('true');
  });

  it('should reset to the first question on start over', () => {
    const { getByRole, getByText } = render(<Questionnaire />);

    fireEvent.click(getByRole('button', { name: /roofing/i }));
    fireEvent.click(getByRole('button', { name: /^next$/i }));
    fireEvent.click(getByRole('button', { name: /asphalt shingle/i }));
    fireEvent.click(getByRole('button', { name: /^next$/i }));

    expect(getByText('Roofing — Asphalt Shingle')).toBeTruthy();

    fireEvent.click(getByRole('button', { name: /start over/i }));
    expect(getByText(/what best describes your trade/i)).toBeTruthy();
  });
});
