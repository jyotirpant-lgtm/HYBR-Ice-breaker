import { Question } from '../types.ts';

export const QUESTIONS: Question[] = [
  {
    number: 1,
    question: "Which capability gap currently slows your team down the most?",
    options: [
      { id: "A", text: "Deep technical or specialized domain skills" },
      { id: "B", text: "Stakeholder management and negotiation" },
      { id: "C", text: "Time management and personal prioritization" },
      { id: "D", text: "Critical thinking and problem-solving under ambiguity" }
    ]
  },
  {
    number: 2,
    question: "What is the single biggest barrier preventing your team from upskilling regularly?",
    options: [
      { id: "A", text: "Zero protected time during working hours" },
      { id: "B", text: "Lack of a clear skill framework or learning path" },
      { id: "C", text: "Budget constraints and lack of high-quality training resources" },
      { id: "D", text: "Lack of immediate, real-world projects to apply new skills" }
    ]
  },
  {
    number: 3,
    question: "How can our management team best accelerate talent growth this year?",
    options: [
      { id: "A", text: "Conducting more structured 1-on-1 career development discussions" },
      { id: "B", text: "Delegating high-visibility stretch assignments to rising talent" },
      { id: "C", text: "Creating internal peer-to-peer knowledge-sharing sessions" },
      { id: "D", text: "Sponsoring external certifications and formal credentials" }
    ]
  },
  {
    number: 4,
    question: "Where does project momentum hit the biggest delay?",
    options: [
      { id: "A", text: "Mid-flight scope adjustments and shifting requirements" },
      { id: "B", text: "Cross-team dependencies and waiting on handoffs" },
      { id: "C", text: "Multi-layered review and sign-off cycles" },
      { id: "D", text: "Legacy tooling and technical debt slowing build velocity" }
    ]
  },
  {
    number: 5,
    question: "When a delivery timeline slips, what is usually the root cause?",
    options: [
      { id: "A", text: "Optimistic planning based on best-case scenarios" },
      { id: "B", text: "Unexpected rework, bugs, or quality issues late in the cycle" },
      { id: "C", text: "Key team members getting pulled into unplanned escalations" },
      { id: "D", text: "Deadlines committed to stakeholders without team input" }
    ]
  },
  {
    number: 6,
    question: "Which operational shift would most improve our delivery consistency?",
    options: [
      { id: "A", text: "Ruthlessly saying \"no\" to late feature requests" },
      { id: "B", text: "Breaking large initiatives into smaller, more frequent releases" },
      { id: "C", text: "Assigning single-person ownership for every final decision" },
      { id: "D", text: "Holding structured post-mortems to capture and apply lessons learned" }
    ]
  },
  {
    number: 7,
    question: "Where is horizontal cross-team collaboration most strained right now?",
    options: [
      { id: "A", text: "Lack of visibility into what other teams are building" },
      { id: "B", text: "Conflicting team KPIs and competing priorities" },
      { id: "C", text: "Siloed ownership over data, systems, or projects" },
      { id: "D", text: "Interaction only occurring when an emergency or blocker arises" }
    ]
  },
  {
    number: 8,
    question: "What is the primary driver of communication fatigue in our department?",
    options: [
      { id: "A", text: "Status update meetings that could easily be shared asynchronously" },
      { id: "B", text: "Sprawling chat channels and fragmented conversation threads" },
      { id: "C", text: "Critical announcements getting buried in lengthy email chains" },
      { id: "D", text: "Artificial urgency, where almost every request is labeled high priority" }
    ]
  },
  {
    number: 9,
    question: "How openly are bad news and critical risks escalated?",
    options: [
      { id: "A", text: "Immediately and transparently as soon as they are spotted" },
      { id: "B", text: "Downplayed or softened until a missed deadline is unavoidable" },
      { id: "C", text: "Shared only within trusted peer circles, rarely escalated upwards" },
      { id: "D", text: "Held back because raising an issue often means being assigned to fix it" }
    ]
  },
  {
    number: 10,
    question: "What is the most frustrating aspect of our current workflows?",
    options: [
      { id: "A", text: "Redundant documentation that rarely gets reviewed" },
      { id: "B", text: "Too many sign-offs required for low-risk operational decisions" },
      { id: "C", text: "Missing standard templates, requiring teams to start from scratch" },
      { id: "D", text: "Disconnected software tools that require manual copy-pasting" }
    ]
  },
  {
    number: 11,
    question: "Why do team members most frequently bypass standard procedures?",
    options: [
      { id: "A", text: "The standard procedure is too slow to hit required deadlines" },
      { id: "B", text: "The official workflow was never clearly documented or trained" },
      { id: "C", text: "Informal workarounds have become the default team habit" },
      { id: "D", text: "There are no checks or consequences for skipping steps" }
    ]
  },
  {
    number: 12,
    question: "If a high performer resigned tomorrow, what would most likely be the reason?",
    options: [
      { id: "A", text: "Hitting a career plateau with no visible promotion track" },
      { id: "B", text: "Sustained workload pressure leading to burnout" },
      { id: "C", text: "Uncompetitive compensation compared to current market offers" },
      { id: "D", text: "Feeling micromanaged or lacking decision-making autonomy" }
    ]
  },
  {
    number: 13,
    question: "What is the primary anchor keeping your best people here today?",
    options: [
      { id: "A", text: "High psychological safety and strong team camaraderie" },
      { id: "B", text: "Challenging, career-defining problems to solve" },
      { id: "C", text: "Schedule flexibility and healthy work-life integration" },
      { id: "D", text: "Strong alignment with departmental leadership and vision" }
    ]
  },
  {
    number: 14,
    question: "What best describes how ownership operates across our frontline staff?",
    options: [
      { id: "A", text: "High agency: individuals identify problems and drive the fix end-to-end" },
      { id: "B", text: "Reactive: individuals flag problems, but wait for managerial direction" },
      { id: "C", text: "Task-bound: individuals execute only what is in their job description" },
      { id: "D", text: "Diffused: accountability slips because task boundaries are ambiguous" }
    ]
  },
  {
    number: 15,
    question: "What would most effectively unleash proactive ideas across the team?",
    options: [
      { id: "A", text: "Carving out dedicated time for experimentation and prototyping" },
      { id: "B", text: "Public recognition and clear incentives for operational improvements" },
      { id: "C", text: "Fast-track pilot approvals without extensive business cases" },
      { id: "D", text: "Visible leadership support when well-intentioned experiments fail" }
    ]
  }
];
