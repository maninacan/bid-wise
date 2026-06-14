import { render, fireEvent, waitFor } from '@testing-library/react';
import { vi } from 'vitest';

import App from './app';
import {
  generateTakeoff,
  listHousePlans,
  uploadHousePlan,
} from '../lib/supabase';

vi.mock('../lib/supabase', () => ({
  ensureSession: vi.fn().mockResolvedValue({ user: { id: 'user-1' } }),
  listHousePlans: vi.fn().mockResolvedValue([]),
  listTakeoffs: vi.fn().mockResolvedValue([]),
  generateTakeoff: vi.fn().mockResolvedValue({
    id: 'takeoff-1',
    plan_id: 'plan-0',
    model: 'claude-opus-4-8',
    created_at: '2026-06-12T00:00:00Z',
    data: {
      projectName: 'Petersen Residence',
      summary: 'Single-family residence with attached garage and bonus room.',
      areas: [{ name: 'Main level', squareFeet: 2704 }],
      sections: [
        {
          trade: 'Roofing',
          items: [
            {
              description: 'Asphalt shingles',
              quantity: 56,
              unit: 'SQ',
              source: 'derived',
              notes: 'Includes 10% waste',
            },
          ],
        },
      ],
      gaps: ['No foundation sheets in set'],
    },
  }),
  getPlanSignedUrl: vi
    .fn()
    .mockResolvedValue('https://example.test/signed/floor-plan.png'),
  uploadHousePlan: vi.fn().mockResolvedValue({
    id: 'plan-1',
    file_name: 'floor-plan.png',
    storage_path: 'user-1/floor-plan.png',
    file_size: 2048,
    content_type: 'image/png',
    created_at: '2026-06-12T00:00:00Z',
  }),
}));

describe('App', () => {
  beforeEach(() => {
    vi.mocked(listHousePlans).mockResolvedValue([]);
  });

  it('should show the Bid Wise logo', async () => {
    const { getByText, findByText } = render(<App />);
    expect(getByText('Bid')).toBeTruthy();
    expect(getByText('Wise')).toBeTruthy();
    await findByText(/upload your house plans/i);
  });

  it('should prompt to upload house plans first, without any sign-in', async () => {
    const { findByText, queryByText } = render(<App />);
    expect(await findByText(/upload your house plans/i)).toBeTruthy();
    expect(queryByText(/sign in/i)).toBeNull();
    expect(queryByText(/what best describes your trade/i)).toBeNull();
  });

  it('should disable Continue until a plan is uploaded', async () => {
    const { findByRole } = render(<App />);
    const next = await findByRole('button', { name: /continue/i });
    expect(next.hasAttribute('disabled')).toBe(true);
  });

  it('should upload a file and continue to the questionnaire', async () => {
    const { container, findByText, findByRole, getByText } = render(<App />);
    await findByText(/upload your house plans/i);

    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(['plan'], 'floor-plan.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(vi.mocked(uploadHousePlan)).toHaveBeenCalledWith('user-1', file);
    });
    expect(await findByText('floor-plan.png')).toBeTruthy();

    const next = await findByRole('button', { name: /continue/i });
    expect(next.hasAttribute('disabled')).toBe(false);
    fireEvent.click(next);

    expect(getByText(/what best describes your trade/i)).toBeTruthy();
  });

  it('should show an image preview of the uploaded plan', async () => {
    const { container, findByText, findByRole } = render(<App />);
    await findByText(/upload your house plans/i);

    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(['plan'], 'floor-plan.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });

    const preview = (await findByRole('img', {
      name: 'floor-plan.png',
    })) as HTMLImageElement;
    expect(preview.src).toBe('https://example.test/signed/floor-plan.png');
  });

  it('should list previously uploaded plans and allow continuing', async () => {
    vi.mocked(listHousePlans).mockResolvedValue([
      {
        id: 'plan-0',
        file_name: 'site-plan.pdf',
        storage_path: 'user-1/site-plan.pdf',
        file_size: 4096,
        content_type: 'application/pdf',
        created_at: '2026-06-11T00:00:00Z',
      },
    ]);

    const { findByText, findByRole } = render(<App />);
    expect(await findByText('site-plan.pdf')).toBeTruthy();
    const next = await findByRole('button', { name: /continue/i });
    await waitFor(() => expect(next.hasAttribute('disabled')).toBe(false));
  });

  it('should generate and display a takeoff for a PDF plan', async () => {
    vi.mocked(listHousePlans).mockResolvedValue([
      {
        id: 'plan-0',
        file_name: 'site-plan.pdf',
        storage_path: 'user-1/site-plan.pdf',
        file_size: 4096,
        content_type: 'application/pdf',
        created_at: '2026-06-11T00:00:00Z',
      },
    ]);

    const { findByRole, findByText, getByText } = render(<App />);
    const button = await findByRole('button', { name: /generate takeoff/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(vi.mocked(generateTakeoff)).toHaveBeenCalledWith('plan-0');
    });
    expect(await findByText(/takeoff — petersen residence/i)).toBeTruthy();
    expect(getByText('Asphalt shingles')).toBeTruthy();
    expect(getByText('Roofing')).toBeTruthy();
    expect(getByText(/no foundation sheets/i)).toBeTruthy();

    // Button toggles to hide/view once generated
    expect(await findByRole('button', { name: /hide takeoff/i })).toBeTruthy();
  });
});
