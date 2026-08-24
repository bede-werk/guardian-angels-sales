// The catalogue of every tunable constant in this app: where it lives, what
// it means, what moving it actually does, and what values are legal.
//
// WHY THIS FILE EXISTS
// The four original config modules (scheduling/driveTime/visitTypes/
// routeOptimizer) each said, in their own header, that "a future
// settings-table phase can lift them out without touching the engine
// itself." This is that phase. Rather than lift the numbers OUT of those
// modules, this registry describes them in place: the config modules stay
// the source of the DEFAULT values, and services/settings.js overlays saved
// overrides onto them at boot.
//
// So there are three layers, and it matters which is which:
//   config/*.js   the default, shipped in code. Never edited at runtime.
//   settings tbl  only the values the user has actually changed.
//   this file     what each one MEANS - labels, help, bounds, legal values.
//
// THE ONE RULE FOR ADDING A TUNABLE
// A field listed here must be readable by its consumer at CALL time. If any
// module does `const { X } = require('../config/foo')` at the top and then
// uses bare `X`, it captured the default at require time and will ignore
// every override forever. Read `cfg.X` inside the function instead. This is
// the only way to get it wrong, and it fails silently, so it's worth
// checking whenever a new field is added here.
//
// `help` is not optional decoration. The whole point of the settings page is
// that the user is never editing a number they don't understand, so every
// field carries a plain-English explanation, and every numeric field also
// says what raising and lowering it does in terms of visits actually
// scheduled - not in terms of the formula.

const LEVEL_OPTIONS = [
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

const VISIT_TYPE_OPTIONS = [
  { value: 'drop_in', label: 'Drop-in' },
  { value: 'check_in', label: 'Check-in' },
  { value: 'working_visit', label: 'Working visit' },
  { value: 'presentation', label: 'Presentation / in-service' },
  { value: 'pre_qualification', label: 'Pre-qualification' },
];

// Every section renders as one card on the settings page, in this order.
// `group.layout` is a hint to the client: 'matrix' renders the 3x3 cadence
// table as a grid, everything else falls back to a stacked list of rows.
const SECTIONS = [
  // ---------------------------------------------------------------- cadence
  {
    id: 'cadence',
    title: 'Visit cadence',
    icon: '🔁',
    blurb:
      'How often a place should be visited, and when the planner is allowed to override that. This is the core of the route planner: every place is scored on how far past its target cadence it has drifted, and the ones that have drifted furthest get proposed first.',
    groups: [
      {
        id: 'cadence-table',
        title: 'Target days between visits',
        layout: 'matrix',
        blurb:
          'The target gap between visits, looked up by the place\'s capacity (how much business it can send) and relationship (how strong the tie already is). The table is deliberately INVERTED: high capacity + weak relationship is visited most often, because that is the biggest gap between potential and reality. If you flatten that inversion, the planner stops chasing opportunity and just services whoever you already know well.',
        matrix: { rows: ['high', 'medium', 'low'], rowLabel: 'Capacity', cols: ['strong', 'medium', 'weak'], colLabel: 'Relationship' },
        fields: [
          { key: 'scheduling.CADENCE_DAYS.high.strong', label: 'High capacity · Strong relationship', unit: 'days', type: 'integer', min: 1, max: 365,
            help: 'A big referral source you already have a real relationship with. Still worth frequent contact, but it does not need rescuing.' },
          { key: 'scheduling.CADENCE_DAYS.high.medium', label: 'High capacity · Medium relationship', unit: 'days', type: 'integer', min: 1, max: 365,
            help: 'A big referral source where the relationship is real but not deep. Worth more attention than the strong cell above.' },
          { key: 'scheduling.CADENCE_DAYS.high.weak', label: 'High capacity · Weak relationship', unit: 'days', type: 'integer', min: 1, max: 365,
            help: 'The highest-opportunity cell in the whole table: they can send a lot of business and you barely know them. This should be the smallest number here.' },
          { key: 'scheduling.CADENCE_DAYS.medium.strong', label: 'Medium capacity · Strong relationship', unit: 'days', type: 'integer', min: 1, max: 365, help: 'A moderate referral source you know well. Maintenance contact.' },
          { key: 'scheduling.CADENCE_DAYS.medium.medium', label: 'Medium capacity · Medium relationship', unit: 'days', type: 'integer', min: 1, max: 365, help: 'The middle of the table. Most of the book tends to land near here once capacity has been pre-qualified.' },
          { key: 'scheduling.CADENCE_DAYS.medium.weak', label: 'Medium capacity · Weak relationship', unit: 'days', type: 'integer', min: 1, max: 365, help: 'Moderate opportunity that has not been developed yet.' },
          { key: 'scheduling.CADENCE_DAYS.low.strong', label: 'Low capacity · Strong relationship', unit: 'days', type: 'integer', min: 1, max: 365, help: 'A friendly contact who does not send much business. Pleasant, low-yield: keep it warm, do not spend the week on it.' },
          { key: 'scheduling.CADENCE_DAYS.low.medium', label: 'Low capacity · Medium relationship', unit: 'days', type: 'integer', min: 1, max: 365, help: 'Low-yield and half-developed.' },
          { key: 'scheduling.CADENCE_DAYS.low.weak', label: 'Low capacity · Weak relationship', unit: 'days', type: 'integer', min: 1, max: 365, help: 'The lowest-priority cell: little business to win and no relationship to protect. This should be the largest number here.' },
        ],
      },
      {
        id: 'cadence-guardrails',
        title: 'Guardrails',
        blurb: 'Two hard limits that sit on top of the cadence table: one stops the planner visiting somewhere too soon, the other lets genuinely neglected places jump the queue.',
        fields: [
          { key: 'scheduling.HARD_FLOOR_DAYS', label: 'Minimum days between visits', unit: 'days', type: 'integer', min: 0, max: 90,
            help: 'A place visited within this many days is never proposed again, no matter how high it scores. It is also what triggers the "you were just here" warning when you plan or log a visit by hand.',
            raise: 'Fewer repeat visits to the same place, and more warnings when you plan one manually.',
            lower: 'The planner is free to send you back sooner. Set to 0 to remove the floor entirely.' },
          { key: 'scheduling.NEGLECT_MULTIPLIER', label: 'Overdue rescue multiplier', unit: 'x cadence', type: 'number', min: 1, max: 10, step: 0.1,
            help: 'How far past its own target cadence a place has to drift before it is treated as endangered and jumps ahead of everything except commitments. At 2, a place with a 21-day cadence gets rescued once it hits 42 days since the last visit.',
            raise: 'The rescue tier fires later and less often, so the planner sticks closer to plain cadence order.',
            lower: 'More places get flagged as endangered, and the planner spends more of each day on rescues than on new opportunity.' },
        ],
      },
      {
        id: 'cadence-fatigue',
        title: 'Fatigue guard',
        blurb: 'Stops the planner hammering one place. If somewhere has already had a lot of visits recently, its target cadence is stretched until the recent count drops back down.',
        fields: [
          { key: 'scheduling.FATIGUE_WINDOW_DAYS', label: 'Fatigue lookback window', unit: 'days', type: 'integer', min: 1, max: 365,
            help: 'How far back the app counts completed visits when deciding whether a place has had too many lately.',
            raise: 'Visits stay "recent" for longer, so fatigue kicks in more easily.',
            lower: 'Only very recent visits count, so fatigue is harder to trigger.' },
          { key: 'scheduling.FATIGUE_THRESHOLD', label: 'Visits before fatigue applies', unit: 'visits', type: 'integer', min: 1, max: 50,
            help: 'How many completed visits inside that window it takes to count as fatigued. Reaching this number stretches the place\'s cadence by the multiplier below.',
            raise: 'It takes more visits to trigger fatigue, so the guard rarely fires.',
            lower: 'Fatigue triggers sooner and the planner spreads itself more thinly across the book.' },
          { key: 'scheduling.FATIGUE_MULTIPLIER', label: 'Fatigue cadence stretch', unit: 'x cadence', type: 'number', min: 1, max: 5, step: 0.1,
            help: 'How much a fatigued place\'s target cadence is stretched. At 1.5, a 21-day cadence becomes 31.5 days until the recent visit count falls back under the threshold.',
            raise: 'A fatigued place waits considerably longer for its next proposal.',
            lower: 'Fatigue barely changes anything. At 1.0 the guard is effectively off.' },
        ],
      },
      {
        id: 'cadence-exploration',
        title: 'Exploration starvation guard',
        blurb: 'Places that have never been pre-qualified sit in their own tier, ordered by best guess at their potential. This stops the least promising of them waiting forever.',
        fields: [
          { key: 'scheduling.EXPLORATION_AGING_DAYS', label: 'Exploration ageing period', unit: 'days', type: 'integer', min: 1, max: 3650,
            help: 'Every time a never-pre-qualified place waits this long, it climbs one rank inside the exploration tier. Eventually even a low-guess place reaches the top on wait time alone.',
            raise: 'Unpromising places wait much longer before the planner gets to them.',
            lower: 'The exploration tier churns faster and low-guess places surface sooner.' },
        ],
      },
    ],
  },

  // --------------------------------------------------------------- capacity
  {
    id: 'capacity',
    title: 'Capacity',
    icon: '📈',
    blurb:
      'Capacity is how much business a place can realistically send you. It is computed, never typed in: the app prefers what you were told on a pre-qualification visit, raises that to a floor if your own referral history proves more, and falls back to a category-based guess when it has neither.',
    groups: [
      {
        id: 'capacity-thresholds',
        title: 'Level thresholds',
        blurb: 'Where the cut lines sit on the single monthly-referral scale that every category shares. Per-category thresholds were deliberately rejected: a place that can send 20 a month is high capacity whether it is a hospital or a law firm.',
        fields: [
          { key: 'scheduling.CAPACITY_THRESHOLDS.MEDIUM_MIN', label: 'Medium starts at', unit: 'referrals/mo', type: 'integer', min: 1, max: 1000,
            help: 'Monthly referral throughput at or above which a place counts as medium capacity. Anything below this is low.',
            raise: 'Fewer places qualify as medium, so more of the book reads low and gets visited less often.',
            lower: 'More places qualify as medium and the planner treats more of the book as worth regular contact.' },
          { key: 'scheduling.CAPACITY_THRESHOLDS.HIGH_MIN', label: 'High starts at', unit: 'referrals/mo', type: 'integer', min: 1, max: 1000,
            help: 'Monthly referral throughput at or above which a place counts as high capacity. Must be greater than the medium threshold.',
            raise: 'High capacity becomes rarer and the top cadence rows apply to fewer places.',
            lower: 'More places land in high capacity, which is the most visit-hungry row of the cadence table.' },
        ],
      },
      {
        // Not 'capacity-seed' - that id belongs to the CATEGORY keyword table
        // further down. Two different fallbacks share the word "seed": this
        // one is the rep's own rating, that one is the guess from the
        // category name when no rating exists either.
        id: 'capacity-rating',
        title: 'Rating choices',
        blurb: 'The four options the "Rate capacity" screen offers, in referrals per month. A rating is your own estimate standing in for a real pre-qualification answer until you get one - it sets the place\'s level, but never marks it as known, so a rated place still shows up for pre-qualification. The moment a place actually tells you its number, that answer replaces your rating outright. Keep each value at least 2 away from a threshold above, or nudging a threshold will silently re-level everything you rated.',
        fields: [
          { key: 'scheduling.CAPACITY_SEED_VALUES.major', label: 'Major source', unit: 'referrals/mo', type: 'integer', min: 1, max: 1000,
            help: 'Your biggest referral sources - the handful of places you would protect above all others.',
            raise: 'Nothing changes unless it crosses a threshold, at which point every place you rated this way jumps a level.',
            lower: 'Same in reverse. This number only matters relative to the level thresholds above.' },
          { key: 'scheduling.CAPACITY_SEED_VALUES.strong', label: 'Strong source', unit: 'referrals/mo', type: 'integer', min: 1, max: 1000,
            help: 'Places that send real, regular business without being your very top accounts.',
            raise: 'Nothing changes unless it crosses a threshold, at which point every place you rated this way jumps a level.',
            lower: 'Same in reverse. This number only matters relative to the level thresholds above.' },
          { key: 'scheduling.CAPACITY_SEED_VALUES.steady', label: 'Steady source', unit: 'referrals/mo', type: 'integer', min: 1, max: 1000,
            help: 'Places good for business on a predictable but modest basis.',
            raise: 'Nothing changes unless it crosses a threshold, at which point every place you rated this way jumps a level.',
            lower: 'Same in reverse. This number only matters relative to the level thresholds above.' },
          { key: 'scheduling.CAPACITY_SEED_VALUES.occasional', label: 'Occasional source', unit: 'referrals/mo', type: 'integer', min: 1, max: 1000,
            help: 'Places that send something once in a while, or that you have no reason to expect much from yet.',
            raise: 'Nothing changes unless it crosses a threshold, at which point every place you rated this way jumps a level.',
            lower: 'Same in reverse. This number only matters relative to the level thresholds above.' },
        ],
      },
      {
        id: 'capacity-measured',
        title: 'Measured floor gate',
        blurb: 'Your own referral history can raise a place\'s capacity above what it declared, but only once there is enough of it to not be noise. This gate only ever raises a number, never lowers it, so a loose setting over-states capacity rather than under-stating it.',
        fields: [
          { key: 'scheduling.MEASURED_MIN_EXPOSURE_DAYS', label: 'Minimum relationship age', unit: 'days', type: 'integer', min: 0, max: 3650,
            help: 'How long you must have been working a place before its referral throughput is allowed to set a capacity floor.',
            raise: 'Only long-standing places can ratchet their own capacity up. Newer wins are ignored for longer.',
            lower: 'A short burst of referrals from a brand-new place can permanently raise its capacity level.' },
          { key: 'scheduling.MEASURED_MIN_REFERRAL_COUNT', label: 'Minimum referrals in window', unit: 'referrals', type: 'integer', min: 1, max: 100,
            help: 'How many referrals must have landed before the measured floor counts at all. This is the guard against a "three referrals in one week" fluke.',
            raise: 'Harder for measured throughput to override a declared capacity.',
            lower: 'Small referral counts start moving capacity levels around.' },
        ],
      },
      {
        id: 'capacity-freshness',
        title: 'Freshness',
        fields: [
          { key: 'scheduling.CAPACITY_STALE_DAYS', label: 'Capacity answer goes stale after', unit: 'days', type: 'integer', min: 1, max: 3650,
            help: 'How long a pre-qualification answer or manual override stays trustworthy. Past this, the place still shows the number but marked stale, and it becomes eligible for re-exploration. Note that a manual override does NOT reset this clock: it says "do not trust the stale number meanwhile", not "this number is current again".',
            raise: 'Old answers keep being treated as current, and you re-ask about capacity less often.',
            lower: 'Capacity answers expire quickly and more places cycle back into the pre-qualification queue.' },
        ],
      },
      {
        id: 'capacity-seed',
        title: 'Starting guess by category',
        blurb: 'For a place that has never been pre-qualified and has no referral history yet, the app guesses capacity from its category name. Rules are checked top to bottom and the FIRST match wins, so order matters: put the more specific rules above the general ones. Matching is case-insensitive and looks for the keyword anywhere in the category name.',
        fields: [
          { key: 'scheduling.CATEGORY_CAPACITY_SEED', label: 'Category rules', type: 'seedTable', options: LEVEL_OPTIONS,
            help: 'Each rule is a set of keywords and the capacity level to assume when a place\'s category contains any of them. A place whose category matches no rule gets the fallback below.' },
          { key: 'scheduling.CATEGORY_CAPACITY_SEED_DEFAULT', label: 'Fallback when no rule matches', type: 'select', options: LEVEL_OPTIONS,
            help: 'Deliberately conservative. An unrecognised category is an unknown quantity, and guessing high would push it up the visit queue on no evidence at all.' },
        ],
      },
    ],
  },

  // ----------------------------------------------------------- relationship
  {
    id: 'relationship',
    title: 'Relationship strength',
    icon: '🤝',
    blurb:
      'Relationship is the other axis of the cadence table, and like capacity it is computed rather than typed in. Every completed visit scores WHO you actually spoke to multiplied by WHAT happened, that score decays with time, and the results roll up from people to their place. One rule worth protecting: relationship must never be driven by referral VOLUME. Volume is the capacity axis, and if both axes read the same signal they collapse into one and the inversion that makes the cadence table useful stops working.',
    groups: [
      {
        id: 'rel-metwith',
        title: 'Who you met',
        blurb: 'The first half of a visit\'s score. Only a named person builds that person\'s own relationship; everything else credits the place as a whole, so a place serviced diligently without ever meeting anyone reads as present but shallow, which is accurate.',
        fields: [
          { key: 'relationship.MET_WITH_WEIGHT.named_person', label: 'A named contact', type: 'number', min: 0, max: 1, step: 0.01, help: 'The full-value case, and the only one that can build an individual person\'s score. Normally left at 1.0, since the rest of this group is expressed relative to it.' },
          { key: 'relationship.MET_WITH_WEIGHT.staff', label: 'Staff (not a named contact)', type: 'number', min: 0, max: 1, step: 0.01, help: 'A real conversation with someone who works there but is not one of your tracked contacts.' },
          { key: 'relationship.MET_WITH_WEIGHT.receptionist', label: 'The receptionist / front desk', type: 'number', min: 0, max: 1, step: 0.01, help: 'You got past the door but not past the desk.' },
          { key: 'relationship.MET_WITH_WEIGHT.nobody', label: 'Nobody', type: 'number', min: 0, max: 1, step: 0.01, help: 'You showed up and spoke to no one. Also used for any old visit where this was never recorded, so it is scored as the weakest known case rather than thrown away or trusted.' },
        ],
      },
      {
        id: 'rel-outcome',
        title: 'What happened',
        blurb: 'The second half of a visit\'s score, multiplied by the who-you-met weight above. These are deliberately observable events rather than judgements about how the visit felt, so they do not inflate over time. A substantive sit-down with a named contact scores 1.0; a drop-off at the front desk scores about 0.01. Both are real visits, and their relationship value genuinely differs by that much.',
        fields: [
          { key: 'relationship.OUTCOME_WEIGHT.substantive', label: 'Substantive conversation', type: 'number', min: 0, max: 1, step: 0.01, help: 'A real conversation with a decision-maker or influencer.' },
          { key: 'relationship.OUTCOME_WEIGHT.introduced_new', label: 'Introduced to someone new', type: 'number', min: 0, max: 1, step: 0.01, help: 'You were introduced to someone new at the organisation. Weighted the same as a substantive conversation: widening the footprint is worth as much as deepening it.' },
          { key: 'relationship.OUTCOME_WEIGHT.brief', label: 'Brief exchange', type: 'number', min: 0, max: 1, step: 0.01, help: 'Short and pleasant but not substantive.' },
          { key: 'relationship.OUTCOME_WEIGHT.materials_only', label: 'Left materials only', type: 'number', min: 0, max: 1, step: 0.01, help: 'You left something behind but had no meaningful contact.' },
          { key: 'relationship.OUTCOME_WEIGHT.unavailable', label: 'Target unavailable', type: 'number', min: 0, max: 1, step: 0.01, help: 'They were out or you were gatekept. Still worth something: you showed up.' },
          { key: 'relationship.OUTCOME_WEIGHT.declined', label: 'Declined', type: 'number', min: 0, max: 1, step: 0.01, help: 'Explicitly not interested right now. This is also the value used for any visit logged under the old outcome list, so old history contributes something without being able to inflate a score.' },
        ],
      },
      {
        id: 'rel-decay',
        title: 'How fast a relationship cools',
        blurb: 'Every visit\'s contribution halves over its category\'s half-life. A hospital relationship genuinely goes cold faster than a funeral home\'s, so the clock is set per category rather than globally.',
        fields: [
          { key: 'relationship.FAST_DECAY_CATEGORIES', label: 'Fast-decay categories', type: 'categories',
            help: 'Categories where relationships fade quickly, usually because of high staff turnover or a large rotating cast of people. Everything not selected here uses the default half-life, including any category you add later.' },
          { key: 'relationship.HALF_LIFE_FAST', label: 'Fast half-life', unit: 'days', type: 'integer', min: 1, max: 3650,
            help: 'For the categories selected above: how long it takes a visit\'s contribution to fade to half its original value.',
            raise: 'Fast-decay relationships hold their score longer and read as strong for longer after a visit.',
            lower: 'Those relationships cool quickly, drop to weak sooner, and get visited more often as a result.' },
          { key: 'relationship.HALF_LIFE_DEFAULT', label: 'Default half-life', unit: 'days', type: 'integer', min: 1, max: 3650,
            help: 'The same clock for every other category. This is also the window used for "did they ask us for something recently".',
            raise: 'Relationships across most of the book hold their score longer.',
            lower: 'Most of the book cools faster and cycles back into the visit queue sooner.' },
        ],
      },
      {
        id: 'rel-reciprocity',
        title: 'Reciprocity',
        blurb: 'Signals that THEY invested in the relationship, not just that you showed up. Without this the score is only a mirror of your own behaviour, and "strong relationship" reduces to "we visit here a lot", which is circular. These multiply the visit score rather than adding to it.',
        fields: [
          { key: 'relationship.DETAIL_BONUS', label: 'Bonus per personal detail known', type: 'number', min: 0, max: 1, step: 0.005,
            help: 'Added once each for a known birthday, recorded preferences, an email address and a phone number. Four details at the default 0.0625 gives a 1.25x multiplier. This is treated as a stock rather than a flow and never decays: you do not stop knowing someone\'s birthday because a quarter went by.',
            raise: 'Knowing people personally counts for more, and filling in contact detail moves scores noticeably.',
            lower: 'Scores lean almost entirely on visit history.' },
          { key: 'relationship.REFERRED_MULTIPLIER', label: 'Has ever referred', unit: 'x', type: 'number', min: 1, max: 3, step: 0.01,
            help: 'Applied once if this person has ever sent a referral. Deliberately binary and never a count, because counting referrals here would collapse the relationship axis into the capacity axis.',
            raise: 'People who have actually sent business score distinctly higher than those who have not.',
            lower: 'Referring matters less to relationship strength. At 1.0 it is ignored entirely.' },
          { key: 'relationship.REQUESTED_MULTIPLIER', label: 'Asked us for something recently', unit: 'x', type: 'number', min: 1, max: 3, step: 0.01,
            help: 'Applied if they asked you for something within the trailing half-life. A request from two years ago is not live reciprocity.',
            raise: 'Being asked for things counts for more.',
            lower: 'Requests barely register. At 1.0 they are ignored entirely.' },
          { key: 'relationship.MAX_RECIPROCITY', label: 'Reciprocity cap', unit: 'x', type: 'number', min: 1, max: 5, step: 0.05,
            help: 'Hard ceiling on the combined reciprocity multiplier, so no combination of the three above can run away. With the defaults the natural maximum is about 1.58, so the 1.6 cap is headroom rather than a live constraint.',
            raise: 'Gives the reciprocity signals more room before they are clipped.',
            lower: 'Clips reciprocity earlier and flattens the difference between reciprocal and one-sided relationships.' },
        ],
      },
      {
        id: 'rel-levels',
        title: 'Strong / medium / weak cut lines',
        blurb: 'These thresholds are deliberately independent of category. Under a constant visit rhythm the score settles at a value that depends only on the ratio of visit gap to half-life, so a fast-decay place visited every 15 days and a normal place visited every 30 both settle at 3.41. One scale, two clocks. For reference: visiting twice as often as the half-life settles at 3.41, exactly at the half-life settles at 2.0, half as often settles at 1.33.',
        fields: [
          { key: 'relationship.RELATIONSHIP_THRESHOLDS.strong', label: 'Strong starts at', type: 'number', min: 0, max: 20, step: 0.1,
            help: 'Score at or above which a relationship reads strong. The default 3.4 corresponds to visiting roughly twice as often as the category half-life.',
            raise: 'Strong becomes rarer. Since strong relationships get the LONGEST cadence, this means more of the book gets visited more often.',
            lower: 'More places read strong and drop into the slower cadence rows.' },
          { key: 'relationship.RELATIONSHIP_THRESHOLDS.medium', label: 'Medium starts at', type: 'number', min: 0, max: 20, step: 0.1,
            help: 'Score at or above which a relationship reads medium; below it, weak. Set to 1.4 rather than the 1.33 convergence value so that "visited half as often as the half-life" reads weak rather than medium.',
            raise: 'More places read weak, which is the most visit-hungry relationship column.',
            lower: 'Fewer places read weak and the planner chases fewer of them.' },
          { key: 'relationship.MEANINGFUL_WEIGHT', label: 'Meaningful visit threshold', type: 'number', min: 0, max: 1, step: 0.05,
            help: 'A visit scoring at or above this counts as "meaningful" and resets the last-meaningful-visit date shown on people. Measured before decay, on purpose: a genuinely substantive visit eight months ago was still substantive at the time. At the default 0.6 that means a named contact plus at least a brief exchange.',
            raise: 'Fewer visits count as meaningful and the person-level cooling flag fires sooner.',
            lower: 'Almost any logged visit resets the clock, which makes the flag much quieter.' },
        ],
      },
      {
        id: 'rel-rollup',
        title: 'Rolling people up to their place',
        fields: [
          { key: 'relationship.CONTRIBUTOR_DECAY', label: 'Each extra contact is worth', unit: 'x the last', type: 'number', min: 0, max: 1, step: 0.05,
            help: 'A place\'s score is its strongest contact, plus this fraction of the next strongest, plus that fraction again of the third, and so on. The strongest relationship sets the floor and breadth still counts, but with sharply diminishing returns, so one genuine champion beats six lukewarm contacts while still pricing in the risk of that champion leaving. A zero-scoring contact contributes exactly zero at any position, so extra weak contacts can never dilute a strong one.',
            raise: 'Breadth counts for more and places with many contacts pull ahead.',
            lower: 'Only the single strongest relationship really matters. At 0 the place score IS its best contact.' },
        ],
      },
      {
        id: 'rel-trend',
        title: 'Heating up and cooling down',
        blurb: 'Display-only badges: they never feed back into the score or level. These are TWO independent mechanisms and neither can stand in for the other. Heating up asks "did something real just happen" by comparing today\'s score with the same computation re-run as of a past date. Cooling down asks "has too much time passed", measured against a target cadence rather than a score ratio, because decay is self-similar: once nothing new happens the ratio locks onto a fixed number and stops moving, so it can say "quiet recently" but never "quiet for a long time".',
        fields: [
          { key: 'relationship.TREND_RELATIVE_THRESHOLD', label: 'Heating-up sensitivity', type: 'number', min: 0.01, max: 2, step: 0.01,
            help: 'How much the score must rise over the lookback window to read as heating up rather than noise. 0.1 means a 10% rise.',
            raise: 'The badge fires only on big moves and appears rarely.',
            lower: 'Small changes trigger it, and it starts showing up on places where nothing much happened.' },
          { key: 'relationship.TREND_WINDOW_FRACTION', label: 'Heating-up lookback', unit: 'x half-life', type: 'number', min: 0.01, max: 1, step: 0.01,
            help: 'The lookback window as a fraction of the category half-life, so a fast-decay category is checked over a shorter window than a slow one. At the default 0.12 that is about 4 days for fast categories and 7 for the rest. Keep this comfortably below the sensitivity above: if plain decay with nothing new can move the score by more than the sensitivity, the badge can never go quiet on its own.',
            raise: 'A longer memory, so the badge lingers after a good visit. Push it too far and it sticks permanently.',
            lower: 'The badge appears and clears quickly, tracking only the last few days.' },
          { key: 'relationship.TREND_EPSILON', label: 'Empty-history floor', type: 'number', min: 0, max: 1, step: 0.005,
            help: 'If the score is at or below this at BOTH ends of the window, the app reads it as no history at either point rather than a trend. Without this, a place going from 0.0001 to 0.0002 would technically be "heating up".',
            raise: 'Very quiet places stop producing trend badges.',
            lower: 'Even tiny scores are treated as real trends.' },
          { key: 'relationship.COOLING_THRESHOLD', label: 'Place cooling threshold', unit: 'x cadence', type: 'number', min: 1, max: 10, step: 0.05,
            help: 'A place is flagged cooling once it is this many times past its own target cadence, measured exactly the way the route planner measures overdue-ness. Deliberately EARLIER than the overdue rescue multiplier so it is an early warning rather than a duplicate of the planner\'s own endangered tier. If you set it at or above that multiplier, the badge stops warning you about anything the planner had not already escalated.',
            raise: 'The badge fires later and appears on fewer places.',
            lower: 'More places show as cooling, sooner.' },
          { key: 'relationship.PERSON_COOLING_HALF_LIFE_FRACTION', label: 'Person cooling threshold', unit: 'x half-life', type: 'number', min: 0.05, max: 5, step: 0.05,
            help: 'A person is flagged cooling once this fraction of their category half-life has passed since their last MEANINGFUL visit. A front-desk drop-off does not reset this clock. At the default 0.5 their score has decayed by about 29%: an early nudge rather than waiting for it to actually halve.',
            raise: 'You are warned later, closer to the point where the relationship has genuinely halved.',
            lower: 'You are nudged much sooner after each meaningful visit.' },
        ],
      },
    ],
  },

  // ------------------------------------------------------------ visit types
  {
    id: 'visitTypes',
    title: 'Visit types and time',
    icon: '⏱️',
    blurb:
      'How long each kind of visit is budgeted for. This is what the planner packs a day against: get these wrong and every generated day is either over-stuffed or half empty. These are budgeting estimates for planning, not targets you are held to.',
    groups: [
      {
        id: 'vt-durations',
        title: 'Expected duration by visit type',
        fields: [
          { key: 'visitTypes.VISIT_TYPES.drop_in.minutes', label: 'Drop-in', unit: 'min', type: 'integer', min: 1, max: 480, help: 'A quick stop: say hello, leave something, go. The cheapest block the planner can fit.' },
          { key: 'visitTypes.VISIT_TYPES.check_in.minutes', label: 'Check-in', unit: 'min', type: 'integer', min: 1, max: 480, help: 'A short relationship touch with one contact.' },
          { key: 'visitTypes.VISIT_TYPES.working_visit.minutes', label: 'Working visit', unit: 'min', type: 'integer', min: 1, max: 480, help: 'A longer sit-down meeting. Roughly 5 to 6 of these fill a default 4-hour day once drive time and overhead are counted.' },
          { key: 'visitTypes.VISIT_TYPES.presentation.minutes', label: 'Presentation / in-service', unit: 'min', type: 'integer', min: 1, max: 480, help: 'A formal in-service. Always chosen by hand, never auto-selected by the planner.' },
          { key: 'visitTypes.VISIT_TYPES.pre_qualification.minutes', label: 'Pre-qualification', unit: 'min', type: 'integer', min: 1, max: 480, help: 'The visit where you find out what a place can actually send you. This is the default type for anywhere that has not been pre-qualified yet.' },
        ],
      },
      {
        id: 'vt-overhead',
        title: 'Per-stop overhead',
        blurb: 'Time that is neither driving nor the visit itself, added to every stop regardless of type.',
        fields: [
          { key: 'visitTypes.PREP_MINUTES', label: 'Prep time', unit: 'min', type: 'integer', min: 0, max: 120,
            help: 'Reviewing notes and history on the way in.',
            raise: 'Fewer stops fit in a day.', lower: 'More stops fit, at the risk of arriving cold.' },
          { key: 'visitTypes.DATA_ENTRY_MINUTES', label: 'Data entry time', unit: 'min', type: 'integer', min: 0, max: 120,
            help: 'Logging the outcome on the way out.',
            raise: 'Fewer stops fit in a day.', lower: 'More stops fit, at the risk of days running long in practice.' },
        ],
      },
      {
        id: 'vt-defaults',
        title: 'Default visit type',
        blurb: 'Which type the planner assumes when nothing else is specified. Anywhere that has not been pre-qualified yet always defaults to a pre-qualification visit regardless of what is set here; this table only applies once capacity has actually been declared.',
        fields: [
          { key: 'visitTypes.DEFAULT_VISIT_TYPE', label: 'Global fallback', type: 'select', options: VISIT_TYPE_OPTIONS,
            help: 'Used when neither the visit nor its place implies a type. The safest choice is the cheapest one, so a missing type never silently over-books a day.' },
          { key: 'visitTypes.DEFAULT_VISIT_TYPE_BY_CAPACITY.high', label: 'High capacity places', type: 'select', options: VISIT_TYPE_OPTIONS, help: 'Default type once a high-capacity place has been pre-qualified. Worth the longer block.' },
          { key: 'visitTypes.DEFAULT_VISIT_TYPE_BY_CAPACITY.medium', label: 'Medium capacity places', type: 'select', options: VISIT_TYPE_OPTIONS, help: 'Default type for a pre-qualified medium-capacity place.' },
          { key: 'visitTypes.DEFAULT_VISIT_TYPE_BY_CAPACITY.low', label: 'Low capacity places', type: 'select', options: VISIT_TYPE_OPTIONS, help: 'Default type for a pre-qualified low-capacity place. Keeping this cheap is what lets low-value stops be squeezed in around the real work.' },
        ],
      },
    ],
  },

  // ------------------------------------------------------------- drive time
  {
    id: 'driveTime',
    title: 'Drive time estimates',
    icon: '🚗',
    blurb:
      'How the app estimates travel between stops when the routing service is unavailable. It works from straight-line distance rather than real roads: good enough to rank and pack stops, not to navigate by. When the routing service does answer, its real numbers are used instead and only the minimum below still applies.',
    groups: [
      {
        id: 'dt-bands',
        title: 'Speed bands',
        blurb: 'One average speed cannot serve both a parking-lot-to-parking-lot hop and a cross-town trip that gets onto a highway, so speed is banded by how far you are actually driving. Bands are measured on estimated ROAD distance, after the circuity factor below is applied.',
        fields: [
          { key: 'driveTime.SHORT_BAND_MAX_MILES', label: 'Short trips are under', unit: 'miles', type: 'number', min: 0.1, max: 100, step: 0.1, help: 'Road distance below which a trip counts as short.' },
          { key: 'driveTime.MEDIUM_BAND_MAX_MILES', label: 'Medium trips are under', unit: 'miles', type: 'number', min: 0.1, max: 500, step: 0.5, help: 'Road distance below which a trip counts as medium. Anything above this is long. Must be greater than the short band.' },
          { key: 'driveTime.SPEED_MPH_SHORT', label: 'Short-trip speed', unit: 'mph', type: 'number', min: 1, max: 100, step: 1,
            help: 'Dominated by turning out of one parking lot and into another. It barely gets out of second gear.',
            raise: 'Nearby stops look cheaper and the planner packs more of them together.',
            lower: 'Nearby stops look more expensive and days come out shorter.' },
          { key: 'driveTime.SPEED_MPH_MEDIUM', label: 'Medium-trip speed', unit: 'mph', type: 'number', min: 1, max: 100, step: 1, help: 'A typical secondary-road hop between nearby stops.' },
          { key: 'driveTime.SPEED_MPH_LONG', label: 'Long-trip speed', unit: 'mph', type: 'number', min: 1, max: 100, step: 1,
            help: 'Long enough to get onto arterials or a highway for at least part of the trip.',
            raise: 'Cross-town trips look cheap and the planner is happier to scatter a day across zones.',
            lower: 'The planner clusters days more tightly.' },
        ],
      },
      {
        id: 'dt-corrections',
        title: 'Corrections',
        fields: [
          { key: 'driveTime.CIRCUITY_FACTOR', label: 'Road distance multiplier', unit: 'x', type: 'number', min: 1, max: 3, step: 0.05,
            help: 'Straight-line distance always understates real road distance, because roads are not straight: grid streets, one-ways, river and rail crossings. 1.3 road miles per straight-line mile is typical for an urban grid.',
            raise: 'Every trip is estimated as longer and days pack more conservatively.',
            lower: 'Estimates get optimistic and generated days risk running over.' },
          { key: 'driveTime.OVERHEAD_MINUTES', label: 'Parking and walking in', unit: 'min', type: 'integer', min: 0, max: 60,
            help: 'The fixed cost of parking and getting through the door, added on top of drive time. Roughly constant whether the next stop is next door or across town.',
            raise: 'Every stop costs more and fewer fit in a day.', lower: 'More stops fit per day.' },
          { key: 'driveTime.MIN_DRIVE_MINUTES', label: 'Minimum drive between stops', unit: 'min', type: 'integer', min: 0, max: 60,
            help: 'A floor so two places in the same building or complex never estimate to nearly zero travel. This one still applies even when the real routing service answers.',
            raise: 'Clusters of very close stops are budgeted more realistically.',
            lower: 'The planner will happily chain same-building stops back to back.' },
        ],
      },
    ],
  },

  // ---------------------------------------------------------- route planner
  {
    id: 'planning',
    title: 'Route planner',
    icon: '🗺️',
    blurb:
      'Bounds on what you can ask the planner for, and the settings for the external routing service it uses to sequence a day\'s stops.',
    groups: [
      {
        id: 'plan-bounds',
        title: 'Planning bounds',
        fields: [
          { key: 'planning.MAX_PLAN_DATES', label: 'Maximum dates per draft', unit: 'dates', type: 'integer', min: 1, max: 60,
            help: 'How many dates can go into a single draft. Each date is planned independently, so this is a limit on how much you take on at once rather than anything the engine needs.',
            raise: 'You can plan further out in one sitting, but generation takes longer.',
            lower: 'Drafts stay small and quick.' },
          { key: 'planning.DEFAULT_HOURS_PER_DAY', label: 'Default hours per day', unit: 'hours', type: 'number', min: 0.5, max: 12, step: 0.5,
            help: 'The starting time budget when you pick a date, and the budget used when a committed day is reopened for editing. You can still change the hours on any individual day.',
            raise: 'Generated days start out fuller.', lower: 'Generated days start out lighter.' },
          { key: 'planning.MAX_DAYS_AHEAD', label: 'Furthest date you can plan', unit: 'weekdays', type: 'integer', min: 1, max: 60,
            help: 'How far into the future a date may be planned, counted in WEEKDAYS so a weekend in the middle of the window does not eat into it. A day\'s ranking is only as fresh as the moment it was generated: a commitment that comes due after you generate will not retroactively reshuffle an already-proposed day, so this bounds how stale a proposal can get.',
            raise: 'You can plan further ahead, at the cost of proposals that may be out of date by the time you drive them.',
            lower: 'Plans stay fresh, but you can only work a short window at a time.' },
        ],
      },
      {
        id: 'plan-optimizer',
        title: 'Route optimizer',
        blurb: 'The app calls a free public OSRM server to put a day\'s stops in the best driving order. It carries no service guarantee, so a slow or failed response never blocks planning: the app quietly falls back to its own straight-line estimates instead.',
        fields: [
          { key: 'routeOptimizer.OSRM_BASE_URL', label: 'Routing service URL', type: 'text', maxLength: 300,
            help: 'Where to send route optimisation requests. The default is the free public OSRM demo server, which needs no API key or signup. Self-hosting OSRM or moving to a paid provider is the upgrade path if the demo server\'s reliability becomes a real problem, and this is the only line that would need to change. If this is wrong or unreachable the app still works, it just falls back to straight-line estimates for stop ordering.' },
          { key: 'routeOptimizer.TIMEOUT_MS', label: 'Routing service timeout', unit: 'ms', type: 'integer', min: 100, max: 60000, step: 100,
            help: 'How long to wait for the routing service before giving up and using straight-line estimates. The public demo server can be slow under load, and generating a schedule still has to finish in a reasonable time when it is.',
            raise: 'More generations get real road distances, but a slow day makes planning feel sluggish.',
            lower: 'Planning stays snappy and falls back to estimates more often.' },
          { key: 'routeOptimizer.MAX_OPTIMIZE_STOPS', label: 'Maximum stops sent to optimize', unit: 'stops', type: 'integer', min: 2, max: 100,
            help: 'A safety cap on how many stops go into one optimisation request. Real headroom over what a working day can hold, since a default 4-hour day fits roughly 5 or 6 stops. This is not meant to be the thing that actually limits a day: rank order decides which stops make the cut, and the optimizer only sequences within it.' },
          { key: 'routeOptimizer.MAX_TOPUP_STOPS', label: 'Absolute stop ceiling', unit: 'stops', type: 'integer', min: 2, max: 200,
            help: 'A genuine technical limit on any single optimisation request, separate from the cap above. After packing a day the planner tries to squeeze in one more stop at a time, and that top-up pass is deliberately allowed to grow past the cap above, so this backstop needs to sit well clear of it or top-up stops working entirely.' },
          { key: 'routeOptimizer.MIN_TOPUP_MINUTES', label: 'Minimum time to attempt top-up', unit: 'min', type: 'integer', min: 1, max: 240,
            help: 'After packing a day, do not bother trying to fit another stop unless at least this much time is left. Should roughly match the cheapest possible block: the shortest visit type plus prep, data entry and the minimum drive. Set it below that and the planner burns time attempting fits that cannot succeed.' },
        ],
      },
    ],
  },

  // --------------------------------------------------------------- referrals
  {
    id: 'referrals',
    title: 'Referrals',
    icon: '📨',
    blurb: 'How referral activity is summarised on people and places. Everything here is derived live from the referral records; nothing is stored or needs upkeep.',
    groups: [
      {
        id: 'ref-window',
        title: 'Recent activity window',
        fields: [
          { key: 'referrals.RECENT_WINDOW_DAYS', label: 'Recent referrals window', unit: 'days', type: 'integer', min: 1, max: 3650,
            help: 'The trailing window behind the "recent referrals" figure shown on people and places. The label follows this number, so it reads "last 90 days" or "last 60 days" to match whatever you set. Note this is display only: the capacity model uses its own, longer gate so that a short burst of referrals cannot permanently ratchet a place\'s capacity up.',
            raise: 'The recent figure smooths out and reflects a longer stretch of history.',
            lower: 'It becomes a sharper, more current signal and swings around more.' },
        ],
      },
    ],
  },

  // --------------------------------------------------------------- dashboard
  {
    id: 'dashboard',
    title: 'Dashboard',
    icon: '📊',
    blurb:
      'How much of each list the five dashboard cards show. Nothing here changes what the planner does or how anything is scored - these only decide how much fits on the screen at once.',
    groups: [
      {
        id: 'dash-commitments',
        title: 'Commitments due',
        blurb:
          'The card that lists promises you have made to go back somewhere. Anything already overdue is always shown no matter what these are set to: a promise does not stop counting because it aged out of a window.',
        fields: [
          { key: 'dashboard.COMMITMENT_HORIZON_DAYS', label: 'Look ahead', unit: 'days', type: 'integer', min: 1, max: 365,
            help: 'How far into the future the card counts a promise as "coming due". Overdue ones are always included on top of this.',
            raise: 'You see further ahead, at the cost of a longer list that is less about this week.',
            lower: 'The card tightens onto what is imminent, and a promise two weeks out stays out of sight until it is closer.' },
          { key: 'dashboard.COMMITMENT_LIST_LIMIT', label: 'Most rows to list', unit: 'rows', type: 'integer', min: 1, max: 100,
            help: 'A cap on the rows drawn, so a big backlog does not turn the dashboard into a scrolling list. The count shown above the list is never capped, so if there are more than this the card says so.' },
        ],
      },
      {
        id: 'dash-referrals',
        title: 'Referral cards',
        blurb:
          'The two referral cards. The "how many lately" figure on the first one follows the Referrals section\'s own recent-activity window, not these.',
        fields: [
          { key: 'dashboard.RECENT_REFERRALS_LIMIT', label: 'Recent referrals to list', unit: 'rows', type: 'integer', min: 1, max: 50,
            help: 'How many of the most recently dated referrals the "Recent referrals" card lists.' },
          { key: 'dashboard.TOP_PARTNERS_LIMIT', label: 'Top partners to list', unit: 'people', type: 'integer', min: 1, max: 50,
            help: 'How many people the "Top referral partners" leaderboard shows, ranked by lifetime referrals sent.' },
        ],
      },
    ],
  },
];

// Flat key -> field index, built once. Used by services/settings.js to
// validate an incoming value and to find which config module owns it.
const FIELDS = new Map();
for (const section of SECTIONS) {
  for (const group of section.groups) {
    for (const field of group.fields) {
      if (FIELDS.has(field.key)) throw new Error(`Duplicate tunable key: ${field.key}`);
      FIELDS.set(field.key, { ...field, sectionId: section.id, groupId: group.id });
    }
  }
}

// First segment of a key names the config module it belongs to.
const NAMESPACES = {
  scheduling: require('./scheduling'),
  driveTime: require('./driveTime'),
  visitTypes: require('./visitTypes'),
  routeOptimizer: require('./routeOptimizer'),
  relationship: require('./relationship'),
  planning: require('./planning'),
  referrals: require('./referrals'),
  dashboard: require('./dashboard'),
};

// Fail loudly at boot rather than silently at save time: a key that names a
// namespace or a path that doesn't exist would otherwise look fine here and
// only blow up the first time somebody tried to change it.
for (const [key, field] of FIELDS) {
  const [ns, ...rest] = key.split('.');
  if (!NAMESPACES[ns]) throw new Error(`Tunable ${key} names unknown config namespace "${ns}"`);
  let node = NAMESPACES[ns];
  for (const seg of rest) {
    if (node == null || !(seg in node)) throw new Error(`Tunable ${key} does not exist in config/${ns}.js`);
    node = node[seg];
  }
  if (field.type !== 'seedTable' && field.type !== 'categories' && (node === null || typeof node === 'object')) {
    throw new Error(`Tunable ${key} resolves to an object; point it at a leaf value instead`);
  }
}

module.exports = { SECTIONS, FIELDS, NAMESPACES, LEVEL_OPTIONS, VISIT_TYPE_OPTIONS };
