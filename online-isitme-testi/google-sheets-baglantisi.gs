/**
 * İSTEĞE BAĞLI: Online işitme testi başvurularını bir Google E-Tablosuna yazar.
 *
 * Kurulum (bir kere, ~5 dakika):
 * 1. Google Drive'da yeni bir E-Tablo açın (ör. "İşitme testi başvuruları").
 * 2. Uzantılar > Apps Script menüsünü açın, bu dosyanın içeriğini yapıştırıp kaydedin.
 * 3. Dağıt > Yeni dağıtım > Tür: Web uygulaması
 *      Yürütme: Ben   ·   Erişim: Herkes
 * 4. Verilen "Web uygulaması URL'si"ni kopyalayın ve isitme-testi.js içindeki
 *    LEAD_ENDPOINT: '' alanına yapıştırın.
 *
 * Böylece ziyaretçi WhatsApp mesajını göndermese bile, iletişim bilgilerini
 * girdiği anda (asama = iletisim) ve test bittiğinde (asama = sonuc) tabloya satır düşer.
 */
var HEADERS = ['Tarih', 'Aşama', 'Ad Soyad', 'Telefon', 'KVKK onayı', 'Kimin için', 'Yaş',
  'Şikâyetler', 'Ne zamandır', 'Cihaz kullanımı', 'Sağ ort. dB', 'Sol ort. dB',
  'Sağ (500/1k/2k/4k/8k)', 'Sol (500/1k/2k/4k/8k)', 'Sonuç'];

function doPost(e) {
  var d = JSON.parse(e.postData.contents);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Başvurular') || ss.insertSheet('Başvurular');
  if (sh.getLastRow() === 0) { sh.appendRow(HEADERS); sh.setFrozenRows(1); }
  // Telefon numarası formül gibi yorumlanmasın diye başına ' eklenir
  sh.appendRow([
    new Date(d.tarih), d.asama, d.ad, "'" + (d.telefon || ''), d.kvkkOnay ? 'Evet' : 'Hayır',
    d.kimIcin, d.yas, d.sikayetler, d.sure, d.cihaz, d.sagOrt, d.solOrt, d.sag, d.sol, d.sonuc
  ]);
  return ContentService.createTextOutput('ok');
}
