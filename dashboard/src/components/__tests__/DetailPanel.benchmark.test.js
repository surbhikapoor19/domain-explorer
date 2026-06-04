import { render, screen, waitFor } from '@testing-library/react';
import DetailPanel from '../DetailPanel';
import * as loader from '../../lib/data-loader';

test('shows status-based validation label from v2 schema', async () => {
  jest.spyOn(loader, 'loadBenchmarkComparisons').mockResolvedValue({
    method_index: { AnyGrasp: {n_wins: 2, n_losses: 0, validations: [], metrics: ['success_rate']} },
    cross_validations: [{method: 'AnyGrasp', metric_label: 'Success Rate (%)',
                         n_papers: 3, status: 'consistent', grade: 'A'}],
  });
  render(<DetailPanel point={{ name: 'AnyGrasp' }} onClose={() => {}} />);
  await waitFor(() => expect(screen.getByText(/2 win/)).toBeInTheDocument());
  expect(screen.getByText(/validated/i)).toBeInTheDocument();
});
