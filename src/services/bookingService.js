const { calendar } = require('@racingpoint/google');
const { getDb } = require('../db/database');
const { getGoogleAuth } = require('./googleAuth');
const logger = require('../utils/logger');

const ATTENDEES = ['usingh@racingpoint.in', 'vishal@racingpoint.in', 'helpdesk@racingpoint.in'];
const LOCATION = 'RacingPoint eSports and Cafe, 3rd Floor, Vantage Line Mall, Hyderabad, Telangana 500091';

function generateBookingId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `RP-${id}`;
}

async function createBooking({ remoteJid, name, phone, email, bookingType, date, startTime, endTime }) {
  const bookingId = generateBookingId();
  const auth = getGoogleAuth();

  const startDateTime = `${date}T${startTime}:00`;
  const endDateTime = `${date}T${endTime}:00`;

  const description = [
    `Booking ID: ${bookingId}`,
    `Customer: ${name}`,
    `Phone: ${phone}`,
    email ? `Email: ${email}` : null,
    `Type: ${bookingType}`,
    `Booked via: WhatsApp`,
  ].filter(Boolean).join('\n');

  const event = await calendar.createEvent({
    auth,
    summary: `Booking: ${name} (${bookingId})`,
    start: startDateTime,
    end: endDateTime,
    description,
    location: LOCATION,
    attendees: ATTENDEES,
  });

  const db = getDb();
  db.prepare(`
    INSERT INTO bookings (booking_id, remote_jid, customer_name, customer_phone, customer_email, booking_type, session_date, start_time, end_time, calendar_event_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(bookingId, remoteJid, name, phone, email || null, bookingType, date, startTime, endTime, event.id);

  logger.info({ bookingId, remoteJid, name }, 'Booking created');

  return { bookingId, event };
}

module.exports = { generateBookingId, createBooking };
