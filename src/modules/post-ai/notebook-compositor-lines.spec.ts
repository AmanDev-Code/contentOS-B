import {
  expandNotebookStructuredRows,
  collectStructuredNotebookLines,
} from './notebook-compositor-lines';

describe('notebook compositor lines', () => {
  it('expands notebook sections into many logical rows and preserves margin snapshots', () => {
    const { mainRows, sidebarLabels } = expandNotebookStructuredRows(
      '',
      [
        {
          subheading: 'Concept',
          lines: Array.from(
            { length: 10 },
            (_, i) =>
              `Line ${i} with dense filler handwriting content for ruler snap`,
          ),
          bulletItems: ['alpha detail', 'beta detail'],
        },
        {
          subheading: 'Pitfall',
          lines: ['Interviewers love to probe this edge case'],
        },
      ],
      [
        'Tip · use ArrayDeque as stack',
        'Mistake · forgetting null head checks',
      ],
    );

    expect(mainRows.length).toBeGreaterThan(12);
    expect(sidebarLabels.length).toBe(2);
  });

  it('collectStructuredNotebookLines aggregates bullets and sections', () => {
    const lines = collectStructuredNotebookLines({
      title: 'T',
      body: 'Body line one',
      bullets: ['b1'],
      notebookSections: [{ lines: ['s1'], subheading: 'H' }],
    });
    expect(lines.join(' ').length).toBeGreaterThan(8);
  });
});
