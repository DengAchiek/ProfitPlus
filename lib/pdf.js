'use strict';
const PDFDocument = require('pdfkit');
const path = require('node:path');
const D = require('../dist/logic.js');

function documentPdf(business, customer, record, kind, summary) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 48, right: 48, bottom: 70, left: 48 }, bufferPages: true, info: { Title: record.number, Author: business.name } });
    const chunks = [];
    doc.on('data', data => chunks.push(data));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    const fontDir = path.dirname(require.resolve('@fontsource/noto-sans/package.json'));
    doc.registerFont('Body', process.env.PDF_FONT_REGULAR || path.join(fontDir, 'files/noto-sans-latin-400-normal.woff'));
    doc.registerFont('Heading', process.env.PDF_FONT_BOLD || path.join(fontDir, 'files/noto-sans-latin-700-normal.woff'));
    doc.font('Heading').fontSize(23).fillColor('#173e33').text(business.name);
    doc.font('Body').fontSize(10).fillColor('#54665d').text([business.address, business.phone, business.email, business.taxId && 'Tax ID: ' + business.taxId].filter(Boolean).join('\n'));
    doc.moveDown(1.5).font('Heading').fontSize(20).fillColor('#173e33').text(kind === 'quotes' ? 'QUOTATION' : 'INVOICE');
    doc.font('Body').fontSize(10).text(record.number + ' · Revision ' + record.version + ' · ' + record.status.toUpperCase());
    doc.text('Issued: ' + record.issuedOn + '     ' + (kind === 'quotes' ? 'Valid until: ' + record.expiresOn : 'Due: ' + record.dueOn));
    doc.moveDown().font('Heading').text('Prepared for');
    doc.font('Body').text([customer.name, customer.company, customer.address, customer.phone, customer.email].filter(Boolean).join('\n'));
    doc.moveDown(1.5);
    const q = kind === 'quotes' ? record : record.quote;
    const r = D.calculateQuote(q), money=n=>D.formatMoney(n,r.currency,'en-US');
    function drawMoney(value,x,y,width){const label=money(value);doc.fontSize(10);if(doc.widthOfString(label)>width)doc.fontSize(8);doc.text(label,x,y,{width,align:'right'});doc.fontSize(10);}
    function tableHeader() {
      const y = doc.y;
      doc.rect(48, y - 5, 499, 27).fill('#e8efdf');
      doc.fillColor('#173e33').font('Heading').fontSize(9);
      doc.text('DESCRIPTION', 56, y, { width: 245 });
      doc.text('QTY', 310, y, { width: 40, align: 'right' });
      doc.text('UNIT PRICE', 355, y, { width: 85, align: 'right' });
      doc.text('AMOUNT', 445, y, { width: 94, align: 'right' });
      doc.y = y + 31;
    }
    tableHeader();
    for (const item of q.items) {
      doc.font('Body').fontSize(10);
      const height = Math.max(28, doc.heightOfString(item.description, { width: 245 }) + 14);
      if (doc.y + height > 735) { doc.addPage(); tableHeader(); }
      const y = doc.y;
      doc.fillColor('#243c32').text(item.description, 56, y, { width: 245 });
      doc.text(String(item.quantity), 310, y, { width: 40, align: 'right' });
      drawMoney(item.unitPrice,355,y,85);
      drawMoney(D.round(item.quantity * item.unitPrice,r.currency),445,y,94);
      doc.moveTo(48, y + height - 7).lineTo(547, y + height - 7).strokeColor('#e2e8dc').stroke();
      doc.y = y + height;
    }
    if (doc.y > 570) doc.addPage();
    doc.moveDown();
    const totals = [['Subtotal', r.subtotal], ['Discount (' + q.discountPercent + '%)', -r.discount], ['Net sales before tax', r.revenue], ['Tax (' + q.taxPercent + '%)', r.tax], ['TOTAL', r.total]];
    if (summary) totals.push(['Payments less refunds', summary.received], ['BALANCE DUE', summary.balance]);
    for (const [label, amount] of totals) {
      const y = doc.y;
      doc.font(label === 'TOTAL' || label === 'BALANCE DUE' ? 'Heading' : 'Body').fontSize(10).text(label, 250, y, { width: 130 });
      drawMoney(amount,385,y,154);
      doc.y = y + 21;
    }
    doc.x = 48;
    if (record.notes) doc.moveDown().font('Heading').text('Notes', { width: 499 }).font('Body').text(record.notes, { width: 499 });
    if (record.terms) doc.moveDown().font('Heading').text('Terms', { width: 499 }).font('Body').text(record.terms, { width: 499 });
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Body').fontSize(8).fillColor('#738174').text(record.number + ' · ' + business.name + ' · Page ' + (i + 1) + ' of ' + pages.count, 48, 798, { lineBreak: false, width: 499, align: 'center' });
      doc.page.margins.bottom = bottomMargin;
    }
    doc.end();
  });
}
module.exports = { documentPdf };
