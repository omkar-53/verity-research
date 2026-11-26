// Controlled benchmark material. These observations are fictional and are never used in user reports.
const settings = [
  ['incremental compilation', 'build duration', 'compiler builds'],
  ['pair programming', 'defect density', 'code review'],
  ['continuous integration', 'release delays', 'software delivery'],
  ['database indexing', 'lookup latency', 'database queries'],
  ['response caching', 'server load', 'web requests'],
  ['static analysis', 'post-release failures', 'software testing'],
  ['test prioritization', 'time to first failure', 'test suites'],
  ['compression', 'network traffic', 'file transfers'],
  ['connection pooling', 'connection overhead', 'database sessions'],
  ['batch scheduling', 'energy consumption', 'compute clusters'],
];
export const fixtures = settings.flatMap(([method, metric, domain], index) =>
  [
    {
      topic: domain,
      claim: 'Does ' + method + ' reduce ' + metric + ' in experiment A?',
      passage:
        'In experiment A, ' +
        method +
        ' reduced ' +
        metric +
        ' by 20% relative to the randomly assigned control group.',
      stance: 'supports',
    },
    {
      topic: domain,
      claim: 'Does ' + method + ' lower ' + metric + ' in experiment B?',
      passage:
        'In experiment B, ' +
        method +
        ' increased ' +
        metric +
        ' by 18% compared with the randomly assigned control group.',
      stance: 'contradicts',
    },
    {
      topic: domain,
      claim: 'Does ' + method + ' reduce ' + metric + ' in experiment C?',
      passage:
        'Experiment C evaluated ' +
        method +
        ' and measured ' +
        metric +
        ', but the confidence interval included both an increase and a decrease.',
      stance: 'inconclusive',
    },
    {
      topic: domain,
      claim: 'Did ' + method + ' lower ' + metric + ' in the 2026 replication?',
      passage:
        'A report mentions plans for a 2026 replication of ' +
        method +
        ' but provides no observations of ' +
        metric +
        '.',
      stance: 'inconclusive',
    },
    {
      topic: domain,
      claim: 'Can ' + method + ' lower ' + metric + ' in experiment E?',
      passage:
        'The experiment E archive contains only a catalog of unrelated paintings from collection ' +
        index +
        '.',
      stance: 'absent',
    },
  ].map((f, i) => ({ ...f, id: index + 1 + '-' + (i + 1) })),
);
