import {
  analyzeCarouselQuality,
  educationalNotebookImageNativeMode,
} from './carousel-quality';

describe('analyzeCarouselQuality', () => {
  const topic = 'DSA in Java interview prep handwritten notes carousel';

  const goodBullets = () => [
    'Concrete Java-facing advice with enough chars to satisfy the gate reliably here',
    'Second substantive teaching bullet about complexity and pitfalls in interviews',
    'Third bullet covering patterns arrays lists stacks queues trees graphs heaps',
    'Fourth bullet about LeetCode study cadence repetition spaced practice interview',
    'Fifth bullet on debugging edge cases iterators generics collections framework',
  ];

  const ink = (frag: string) =>
    `${frag} ${'Density filler for quality gate characters and ruled-line teaching prose '.repeat(3)}`;

  it('flags wrong slide count and placeholder titles including bare Slide N', () => {
    const issues = analyzeCarouselQuality({
      slides: [
        {
          title: 'Slide 3',
          body: 'x'.repeat(60),
          imagePrompt:
            'lined notebook desk paper dotted texture overhead study mood',
          bullets: goodBullets(),
        },
        {
          title: 'Carousel slide 2',
          body: 'y'.repeat(60),
          imagePrompt:
            'ruled margins cream paper faint marker smudges no text study',
          bullets: goodBullets(),
        },
      ],
      expectedCount: 12,
      topicLower: topic.toLowerCase(),
      resolvedVisualStyle: 'handwritten_notebook',
      noteDensity: 'standard',
    });

    expect(issues.some((i) => i.code === 'slide_count')).toBe(true);
    expect(issues.some((i) => i.code === 'placeholder_title')).toBe(true);
  });

  it('rejects generic 12-slide deck missing DSA arc keyword coverage when topic implies Java interviews', () => {
    /** Bullets deliberately avoid JAVA_DSA_DECK_TERMS substrings ("list", "graph", etc.). */
    const neutralBullets = () =>
      Array.from({ length: 5 }, (_, j) =>
        `Zyxxkw filler cadence mnemonic-free prose ${j} qwopvn`.repeat(2),
      );

    const neutralBody = `${'Zyxxkw banal qwopvn mnemonic-free qwopqwop cadence aaa '.repeat(5)}`;

    const placeholderDeck = Array.from({ length: 12 }, (_, i) => ({
      title: `Narrow micro-topic focus ordinal ${i + 1} for filler cadence prose`,
      body: neutralBody + ` ordinal ${i + 1}`,
      bullets: neutralBullets(),
      imagePrompt:
        'overhead desk dotted notebook paper faint pencil shading study texture background',
    }));

    const issues = analyzeCarouselQuality({
      slides: placeholderDeck,
      expectedCount: 12,
      topicLower: topic.toLowerCase(),
      resolvedVisualStyle: 'handwritten_notebook',
      noteDensity: 'standard',
    });

    expect(issues.some((i) => i.code === 'topic_keywords_weak')).toBe(true);
  });

  it('accepts a substantive 12-slide deck aligned with topic (handwritten style)', () => {
    const arcs: [string, string[]][] = [
      ['Why DSA mastery still wins FAANG loops', ['java', 'interview']],
      ['Java arrays contiguous memory pitfalls', ['array', 'complexity']],
      ['String handling StringBuilder slicing', ['string']],
      ['Linked lists fast insert removal Java', ['list']],
      ['Monotonic stacks parenthesis traps', ['stack']],
      ['Queues ArrayDeque deque interview tips', ['queue']],
      ['Hash maps sets collisions equals hashCode', ['hash']],
      ['Trees BST traversals iterative tricks', ['tree']],
      ['Heaps priority queues schedules limits', ['heap']],
      ['Graph basics BFS DFS grids', ['graph']],
      ['Recursion vs DP overlap subproblems patterns', ['recurs', 'dynamic']],
      [
        'Interview playbook LeetCode roadmap cadence study',
        ['leetcode', 'interview'],
      ],
    ];

    const slides = arcs.map(([title, keys], i) => ({
      title: String(title),
      body: ink(
        `${String(title)} bridge ${keys.join(', ')} slide ${i + 1} handwritten prep carousel`,
      ),
      bullets: goodBullets(),
      imagePrompt:
        'top-down dotted notebook desk paper texture faint marker doodles illegible scribbles overhead study lamp',
      notebookSections: [
        {
          subheading: 'Concept',
          lines: [
            ink(
              `Java-facing ${keys[0]} intuition for interview cadence and live coding`,
            ),
            ink(
              `Second ink line for mental models plus API cues on ${keys.join('/')}`,
            ),
            ink(
              `Third line about pragmatic traps students reproduce under time pressure`,
            ),
            ink(
              `Fourth line contrasting this structure with adjacent DS patterns in Java`,
            ),
            ink(
              `Fifth micro-story about debugging a wrong invariant on a whiteboard stress test`,
            ),
            ink(
              `Sixth line tying the pattern back to real JDK classes you can name aloud`,
            ),
            ink(
              `Seventh line rehearsal cue you whisper before starting implementation on the clock`,
            ),
          ],
        },
        {
          subheading: 'Pitfalls + drills',
          lines: [
            ink(
              `Big-O plus JVM nuance reminders tied to ${keys[0]} for interviewers`,
            ),
            ink(
              `Follow-up probes you should rehearse aloud before writing full solutions`,
            ),
            ink(
              `Third drill on incremental extension when input size doubles unexpectedly`,
            ),
            ink(
              `Fourth drill comparing two competing implementations on cache behavior`,
            ),
            ink(
              `Fifth drill mentioning testing harness ideas without losing interview pace`,
            ),
            ink(
              `Sixth drill: one sentence on how you would defend space trade-offs in Java memory`,
            ),
          ],
          bulletItems: [
            ink(
              'Mini bullet rehearse spoken answer under time pressure with clarity',
            ),
            ink(
              'Second bullet about tracing a tiny example before touching the IDE',
            ),
          ],
        },
      ],
      marginNotes: [
        'Tip · rehearse aloud why this structure beats brute force scanning for large inputs in interviews today',
        'Mistake · skipping mention of iterator semantics or concurrent modification when using Java collections',
      ],
      codeSnippets: ['Map<String,Integer> freq = new HashMap<>();'],
      denseBullets: [
        ink(
          'Dense bullet echoing invariant you must repeat in the hallway after the interview',
        ),
        ink(
          'Second dense bullet about timeboxing and when to abandon a stuck approach',
        ),
        ink(
          'Third dense bullet on annotating the sheet with corner cases before you code',
        ),
      ],
    }));

    const issues = analyzeCarouselQuality({
      slides,
      expectedCount: 12,
      topicLower: topic.toLowerCase(),
      resolvedVisualStyle: 'handwritten_notebook',
    });

    expect(issues).toHaveLength(0);
  });

  it('accepts moderate-density 12-slide dense Java DSA notebook (typical model output)', () => {
    const line = (c: string) => c.repeat(68);
    const slides = Array.from({ length: 12 }, (_, i) => ({
      title: `Java DSA interview pillar ${i + 1} for whiteboard stress`,
      body: `Arrays lists stacks queues trees graphs heaps recap slide ${i + 1} `.repeat(
        4,
      ),
      imagePrompt:
        'overhead desk dotted notebook paper faint pencil shading study texture background',
      notebookSections: [
        {
          subheading: 'Concept · what to say first',
          lines: [line('a'), line('b'), line('c'), line('d')],
        },
        {
          subheading: 'Pitfalls · watch in live coding',
          lines: [line('e'), line('f'), line('g')],
          bulletItems: [line('h').slice(0, 58)],
        },
      ],
      marginNotes: [
        'Tip · rehearse Big-O out loud for this pattern before you touch the marker',
        'Mistake · skipping null checks on containers when the input size looks friendly',
      ],
      codeSnippets: ['Map<String,Integer> m = new HashMap<>();'],
      denseBullets: [
        line('i').slice(0, 54),
        line('j').slice(0, 52),
        line('k').slice(0, 55),
      ],
    }));

    const issues = analyzeCarouselQuality({
      slides,
      expectedCount: 12,
      topicLower: 'java dsa leetcode interview handwritten notes',
      resolvedVisualStyle: 'handwritten_notebook_dense',
      noteDensity: 'dense',
      programmingModeEffective: true,
    });

    expect(issues).toHaveLength(0);
  });

  it('filled handwriting topic rejects decks under per-slide line budget', () => {
    const slides = Array.from({ length: 12 }, (_, i) => ({
      title: `Java DSA pillar title ${i + 1} with enough length for gate`,
      body: ink(`Body ordinal ${i + 1} for slide budget failure case`),
      bullets: goodBullets().slice(0, 3),
      imagePrompt:
        'overhead desk dotted notebook paper faint pencil shading study texture background',
    }));

    const issues = analyzeCarouselQuality({
      slides,
      expectedCount: 12,
      topicLower: 'complete handwritten notes java dsa interviews',
      resolvedVisualStyle: 'handwritten_notebook',
    });

    expect(
      issues.some((i) => i.code === 'handwriting_slide_line_budget_low'),
    ).toBe(true);
  });

  it('requires notebook-related image cues when handwritten_notebook resolved style', () => {
    const slides = Array.from({ length: 12 }, (_, i) => ({
      title: `Java interviews topic pillar ${i + 1}`,
      body: `Arrays lists stacks queues trees graphs heaps recursion DP LeetCode study ${i} `.repeat(
        3,
      ),
      bullets: goodBullets(),
      imagePrompt:
        'random steak dinner plating hero shot restaurant menu bokeh cinematic',
    }));

    const issues = analyzeCarouselQuality({
      slides,
      expectedCount: 12,
      topicLower: topic.toLowerCase(),
      resolvedVisualStyle: 'handwritten_notebook',
      noteDensity: 'standard',
    });

    expect(issues.some((i) => i.code === 'image_prompt_style_mismatch')).toBe(
      true,
    );
  });

  it('dense mode rejects sparse slides without structured sections', () => {
    const thin = Array.from({ length: 12 }, (_, i) => ({
      title: `Java DSA pillar ${i + 1} with enough title length`,
      body: 'Too short body that should fail dense validation rules here.',
      bullets: ['a', 'b', 'c'],
      imagePrompt:
        'overhead desk dotted notebook paper faint pencil shading study texture background',
    }));
    const issues = analyzeCarouselQuality({
      slides: thin,
      expectedCount: 12,
      topicLower: topic.toLowerCase(),
      resolvedVisualStyle: 'handwritten_notebook_dense',
      noteDensity: 'dense',
    });
    expect(issues.some((i) => i.code === 'dense_missing_sections')).toBe(true);
    expect(issues.some((i) => i.code === 'dense_margin_missing')).toBe(true);
  });

  it('programming mode flags decks with almost no code-ish surface', () => {
    const neutralBullets = () =>
      Array.from({ length: 5 }, (_, j) =>
        `Narrative fluff cadence ${j} without syntax markers zzz`.repeat(2),
      );

    const fluff = Array.from({ length: 8 }, (_, i) => ({
      title: `Abstract concept ${i + 1}`,
      body: 'Warm inspirational narrative about studying hard with no syntax or complexity notes at all repeat words',
      bullets: neutralBullets(),
      imagePrompt:
        'overhead desk dotted notebook paper faint pencil shading study texture background',
      notebookSections: [
        {
          subheading: 'Story arc',
          lines: [
            'Once upon a motivation tale that never mentions java or loops or maps',
          ],
        },
        {
          subheading: 'Mindset',
          lines: ['Think deeply about effort without technical detail'],
        },
      ],
      marginNotes: [
        'Tip · breathe deeply today',
        'Remember · focus on calm study habits',
      ],
    }));

    const issues = analyzeCarouselQuality({
      slides: fluff,
      expectedCount: 8,
      topicLower: 'java dsa interview cheatsheet',
      resolvedVisualStyle: 'handwritten_notebook_dense',
      noteDensity: 'dense',
      programmingModeEffective: true,
    });
    expect(issues.some((i) => i.code === 'programming_surface_weak')).toBe(
      true,
    );
  });
});

describe('educationalNotebookImageNativeMode', () => {
  it('requires educational notebook style + topic study cues', () => {
    expect(
      educationalNotebookImageNativeMode({
        tonality: 'educational',
        topicLower: 'java dsa handwritten study notes carousel',
        visualStyle: 'handwritten_notebook',
      }),
    ).toBe(true);
    expect(
      educationalNotebookImageNativeMode({
        tonality: 'professional',
        topicLower: 'java dsa notes',
        visualStyle: 'handwritten_notebook',
      }),
    ).toBe(false);
    expect(
      educationalNotebookImageNativeMode({
        tonality: 'educational',
        topicLower: 'college fest recap',
        visualStyle: 'handwritten_notebook',
      }),
    ).toBe(false);
    expect(
      educationalNotebookImageNativeMode({
        tonality: 'educational',
        topicLower: 'whiteboard recap',
        visualStyle: 'whiteboard_notes',
      }),
    ).toBe(false);
  });
});
