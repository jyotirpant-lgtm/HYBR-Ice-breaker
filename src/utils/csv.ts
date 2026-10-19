import { Question, ParticipantData, ResponseData } from '../types.ts';

interface ExportCSVParams {
  sessionCode: string;
  questions: Question[];
  participants: { id: string; data: ParticipantData }[];
  responses: ResponseData[];
}

export function generateResponsesCSV({
  sessionCode,
  questions,
  participants,
  responses
}: ExportCSVParams): string {
  // Columns: session code, participant name, question number, question text, rank 1, rank 2, rank 3, rank 4, submitted at
  const headers = [
    'session code',
    'participant name',
    'question number',
    'question text',
    'rank 1',
    'rank 2',
    'rank 3',
    'rank 4',
    'submitted at'
  ];

  // Map of response lookup: `${questionIndex}_${participantId}`
  const responseMap = new Map<string, ResponseData>();
  responses.forEach((res) => {
    responseMap.set(`${res.questionIndex}_${res.participantId}`, res);
  });

  const rows: string[][] = [];

  // One row per participant per question
  participants.forEach((participant) => {
    questions.forEach((q, qIdx) => {
      const resp = responseMap.get(`${qIdx}_${participant.id}`);

      const rank1 = resp?.rankedOptions[0] ? `Option ${resp.rankedOptions[0]}` : '';
      const rank2 = resp?.rankedOptions[1] ? `Option ${resp.rankedOptions[1]}` : '';
      const rank3 = resp?.rankedOptions[2] ? `Option ${resp.rankedOptions[2]}` : '';
      const rank4 = resp?.rankedOptions[3] ? `Option ${resp.rankedOptions[3]}` : '';
      const submittedAt = resp?.submittedAt ? new Date(resp.submittedAt).toISOString() : '';

      rows.push([
        sessionCode,
        participant.data.name,
        String(q.number),
        `"${q.question.replace(/"/g, '""')}"`,
        rank1,
        rank2,
        rank3,
        rank4,
        submittedAt
      ]);
    });
  });

  const csvContent = [
    headers.join(','),
    ...rows.map((row) => row.join(','))
  ].join('\n');

  return csvContent;
}

export function downloadCSV(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
