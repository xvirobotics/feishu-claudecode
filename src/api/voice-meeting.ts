import * as crypto from 'node:crypto';
import type { Logger } from '../utils/logger.js';
import type { BotRegistry } from './bot-registry.js';

export interface MeetingParticipant {
  botName: string;
  prompt: string;
  responseText?: string;
  costUsd?: number;
  durationMs?: number;
  ttsVoice?: string;
}

export interface Meeting {
  id: string;
  title: string;
  participants: MeetingParticipant[];
  status: 'pending' | 'running' | 'completed' | 'failed';
  chatId: string;
  initiatedBy: string;
  createdAt: number;
  completedAt?: number;
  notes?: string;
}

export class VoiceMeetingService {
  private meetings = new Map<string, Meeting>();
  private logger: Logger;
  private registry: BotRegistry;

  constructor(registry: BotRegistry, logger: Logger) {
    this.registry = registry;
    this.logger = logger.child({ module: 'voice-meeting' });
  }

  /**
   * Create and start a meeting. Each bot is called sequentially with its prompt.
   * Returns the meeting with all responses collected.
   */
  async startMeeting(options: {
    title: string;
    chatId: string;
    initiatedBy: string;
    participants: Array<{ botName: string; prompt: string; ttsVoice?: string }>;
    onParticipantDone?: (participant: MeetingParticipant, index: number, total: number) => void;
  }): Promise<Meeting> {
    const meeting: Meeting = {
      id: crypto.randomUUID().slice(0, 8),
      title: options.title,
      participants: options.participants.map((p) => ({
        botName: p.botName,
        prompt: p.prompt,
        ttsVoice: p.ttsVoice,
      })),
      status: 'running',
      chatId: options.chatId,
      initiatedBy: options.initiatedBy,
      createdAt: Date.now(),
    };
    this.meetings.set(meeting.id, meeting);
    this.logger.info(
      { meetingId: meeting.id, title: meeting.title, participants: meeting.participants.length },
      'Meeting started',
    );

    try {
      for (let i = 0; i < meeting.participants.length; i++) {
        const participant = meeting.participants[i];
        const bot = this.registry.get(participant.botName);

        if (!bot) {
          participant.responseText = `Bot "${participant.botName}" not found`;
          continue;
        }

        const meetingContext = [
          `[Meeting: "${meeting.title}"]`,
          `You are in a team meeting. Give a brief status update in 2-4 sentences.`,
          `Do NOT use markdown, code blocks, or formatting. Speak naturally as if in a meeting.`,
          `Respond in the same language as the prompt.`,
          '',
          participant.prompt,
        ].join('\n');

        const startTime = Date.now();
        try {
          const result = await bot.bridge.executeApiTask({
            prompt: meetingContext,
            chatId: `meeting-${meeting.id}-${participant.botName}`,
            userId: meeting.initiatedBy,
            sendCards: false,
            maxTurns: 1,
          });
          participant.responseText = result.responseText || '(No response)';
          participant.costUsd = result.costUsd;
          participant.durationMs = Date.now() - startTime;
        } catch (err: any) {
          participant.responseText = `Error: ${err.message}`;
          participant.durationMs = Date.now() - startTime;
        }

        options.onParticipantDone?.(participant, i, meeting.participants.length);
      }

      // Generate meeting notes
      meeting.notes = this.generateNotes(meeting);
      meeting.status = 'completed';
      meeting.completedAt = Date.now();
      this.logger.info(
        { meetingId: meeting.id, durationMs: meeting.completedAt - meeting.createdAt },
        'Meeting completed',
      );
    } catch (err: any) {
      meeting.status = 'failed';
      meeting.completedAt = Date.now();
      this.logger.error({ err, meetingId: meeting.id }, 'Meeting failed');
    }

    return meeting;
  }

  private generateNotes(meeting: Meeting): string {
    const lines = [
      `# Meeting: ${meeting.title}`,
      `Date: ${new Date(meeting.createdAt).toISOString()}`,
      `Duration: ${meeting.completedAt ? Math.round((meeting.completedAt - meeting.createdAt) / 1000) + 's' : 'N/A'}`,
      '',
      '## Participants',
      '',
    ];

    for (const p of meeting.participants) {
      lines.push(`### ${p.botName}`);
      lines.push(p.responseText || '(No response)');
      if (p.costUsd) lines.push(`Cost: $${p.costUsd.toFixed(4)}`);
      lines.push('');
    }

    const totalCost = meeting.participants.reduce((sum, p) => sum + (p.costUsd || 0), 0);
    lines.push(`---`);
    lines.push(`Total cost: $${totalCost.toFixed(4)}`);

    return lines.join('\n');
  }

  getMeeting(id: string): Meeting | undefined {
    return this.meetings.get(id);
  }

  listMeetings(): Meeting[] {
    return Array.from(this.meetings.values()).sort((a, b) => b.createdAt - a.createdAt);
  }
}
