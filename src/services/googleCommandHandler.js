const { gmail, calendar, sheets, drive } = require('@racingpoint/google');
const { getGoogleAuth } = require('./googleAuth');
const config = require('../config');
const logger = require('../utils/logger');

function isAdmin(remoteJid) {
  // remoteJid format: 917981264279@s.whatsapp.net
  const number = remoteJid.split('@')[0];
  return config.google.adminNumbers.includes(number);
}

function tryGoogleCommand(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('!')) return null;

  const parts = trimmed.substring(1).split(/\s+/);
  const command = parts[0]?.toLowerCase();
  const args = parts.slice(1).join(' ');

  const commands = [
    'inbox', 'email', 'sendemail',
    'upcoming', 'newevent', 'deleteevent',
    'readsheet', 'writesheet',
    'drivelist', 'driveshare',
  ];

  if (!commands.includes(command)) return null;

  return { command, args };
}

async function executeGoogleCommand({ command, args }, remoteJid) {
  const auth = getGoogleAuth();

  switch (command) {
    case 'inbox': {
      const count = parseInt(args) || 5;
      const emails = await gmail.listInbox({ auth, maxResults: count });
      if (emails.length === 0) return 'No emails found.';
      return emails.map((e, i) =>
        `*${i + 1}.* ${e.subject || '(No subject)'}\nFrom: ${e.from}\nID: ${e.id}`
      ).join('\n\n');
    }

    case 'email': {
      if (!args) return 'Usage: !email <message-id>';
      const email = await gmail.readEmail({ auth, messageId: args.trim() });
      const body = email.body.length > 1500 ? email.body.substring(0, 1500) + '...' : email.body;
      return `*${email.subject}*\nFrom: ${email.from}\nTo: ${email.to}\nDate: ${email.date}\n\n${body}`;
    }

    case 'sendemail': {
      const parts = args.split('|').map(p => p.trim());
      if (parts.length < 3) return 'Usage: !sendemail to@email.com | Subject | Body';
      const [to, subject, ...bodyParts] = parts;
      const body = bodyParts.join(' | ');
      const result = await gmail.sendEmail({ auth, to, subject, body });
      return `Email sent to ${to}! (ID: ${result.id})`;
    }

    case 'upcoming': {
      const count = parseInt(args) || 5;
      const events = await calendar.listEvents({ auth, maxResults: count });
      if (events.length === 0) return 'No upcoming events.';
      return events.map((e, i) => {
        const start = new Date(e.start).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        let line = `*${i + 1}. ${e.summary}*\n${start}`;
        if (e.location) line += `\nLocation: ${e.location}`;
        line += `\nID: ${e.id}`;
        return line;
      }).join('\n\n');
    }

    case 'newevent': {
      const parts = args.split('|').map(p => p.trim());
      if (parts.length < 3) return 'Usage: !newevent Title | 2026-03-01T14:00:00 | 2026-03-01T16:00:00 | Description (optional)';
      const [summary, start, end, description] = parts;
      const event = await calendar.createEvent({ auth, summary, start, end, description });
      return `Event created: *${event.summary}*\nStart: ${new Date(event.start).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\nID: ${event.id}`;
    }

    case 'deleteevent': {
      if (!args) return 'Usage: !deleteevent <event-id>';
      await calendar.deleteEvent({ auth, eventId: args.trim() });
      return `Event deleted.`;
    }

    case 'readsheet': {
      const parts = args.split(/\s+/);
      if (parts.length < 2) return 'Usage: !readsheet <spreadsheet-id-or-url> <range>';
      const [spreadsheetId, ...rangeParts] = parts;
      const range = rangeParts.join(' ');
      const data = await sheets.readRange({ auth, spreadsheetId, range });
      if (data.length === 0) return 'No data found.';
      return data.map(row => row.join(' | ')).join('\n');
    }

    case 'writesheet': {
      const pipeIdx = args.indexOf('|');
      if (pipeIdx === -1) return 'Usage: !writesheet <spreadsheet-id> <range> | value1, value2, value3';
      const before = args.substring(0, pipeIdx).trim().split(/\s+/);
      const valuesStr = args.substring(pipeIdx + 1).trim();
      if (before.length < 2) return 'Usage: !writesheet <spreadsheet-id> <range> | value1, value2, value3';
      const [spreadsheetId, range] = before;
      const values = [valuesStr.split(',').map(v => v.trim())];
      const result = await sheets.writeRange({ auth, spreadsheetId, range, values, append: true });
      return `Appended: ${result.updatedCells} cell(s) updated.`;
    }

    case 'drivelist': {
      const folderId = args.trim() || undefined;
      const files = await drive.listFiles({ auth, folderId, maxResults: 10 });
      if (files.length === 0) return 'No files found.';
      return files.map((f, i) =>
        `*${i + 1}.* ${f.name}\nType: ${f.mimeType}\nID: ${f.id}`
      ).join('\n\n');
    }

    case 'driveshare': {
      if (!args) return 'Usage: !driveshare <file-id>';
      const link = await drive.getShareableLink({ auth, fileId: args.trim() });
      return `Shareable link: ${link}`;
    }

    default:
      return 'Unknown command.';
  }
}

module.exports = { tryGoogleCommand, executeGoogleCommand, isAdmin };
