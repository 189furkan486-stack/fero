/* Trakya İşitme · Online işitme testi
   Bağımlılık yok. Web Audio API ile saf ses (sinüs) üretir, basitleştirilmiş
   Hughson-Westlake yöntemiyle (10 dB in / 5 dB çık) her kulak ve frekans için
   eşik bulur. Sonuç tıbbi tanı değildir; kalibre edilmemiş kulaklıkla yaklaşık
   bir ön değerlendirmedir. */
(function () {
  'use strict';

  /* ================= AYARLAR ================= */
  var CONFIG = {
    WA_NUMBER: '905441821881',
    PHONE_DISPLAY: '0544 182 18 81',
    PHONE_TEL: '+905441821881',
    // İsteğe bağlı: başvuruları bir Google E-Tablosuna yazmak için Apps Script
    // web uygulaması adresi (bkz. google-sheets-baglantisi.gs). Boşsa sadece WhatsApp kullanılır.
    LEAD_ENDPOINT: '',
    PHONE_REQUIRED: true,
    FREQS: [1000, 2000, 4000, 8000, 500],   // test sırası (klinikteki gibi 1 kHz ile başlar)
    CHART_FREQS: [500, 1000, 2000, 4000, 8000],
    EARS: ['right', 'left'],
    CATCH_RATE: 0.12                         // sessiz kontrol denemesi oranı
  };

  /* ================= SES MOTORU =================
     Kalibrasyon: kullanıcı 1 kHz referans sesini "normal konuşma kadar net" duyacak
     şekilde cihaz sesini ayarlar. Bu ses ~50 dB HL kabul edilir ve -20 dBFS'te çalınır.
     Böylece 0 dB HL ≈ -70 dBFS olur. Frekanslar arası fark için kulaklık
     referans eşik değerlerinin (RETSPL) 1 kHz'e göre farkları eklenir. */
  var CAL_DBHL = 50;
  var REF_DBFS_0HL = -70;
  var RETSPL_REL = { 250: 18.5, 500: 4.5, 1000: 0, 2000: 2, 3000: 2.5, 4000: 2.5, 6000: 6, 8000: 6 };
  var MIN_DB = 0;

  function dbfsFor(freq, dbhl) { return REF_DBFS_0HL + dbhl + (RETSPL_REL[freq] || 0); }
  function ampFor(freq, dbhl) { return Math.min(1, Math.pow(10, dbfsFor(freq, dbhl) / 20)); }
  function maxDb(freq) { return Math.floor((-1 - REF_DBFS_0HL - (RETSPL_REL[freq] || 0)) / 5) * 5; }

  var ctx = null, merger = null, swapped = false;
  function audio() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* eski Safari */ }
      ctx = new AC();
      merger = ctx.createChannelMerger(2);
      merger.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function channelOf(ear) {
    var right = ear === 'right';
    if (swapped) right = !right;
    return right ? 1 : 0;
  }
  // Darbeli ton (3 x 320 ms). Darbeli ses sürekli sese göre daha kolay fark edilir.
  var PULSES = 3, ON = 0.32, OFF = 0.18;
  function playTone(o) {
    var c = audio(); if (!c) return null;
    var pulses = o.pulses || PULSES, on = o.on || ON, off = o.off || OFF;
    var t0 = c.currentTime + 0.05 + (o.delay || 0);
    var osc = c.createOscillator(); osc.type = 'sine'; osc.frequency.value = o.freq;
    var g = c.createGain(); g.gain.setValueAtTime(0, c.currentTime);
    var amp = o.amp != null ? o.amp : ampFor(o.freq, o.level), r = 0.025;
    for (var i = 0; i < pulses; i++) {
      var s = t0 + i * (on + off);
      g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(amp, s + r);
      g.gain.setValueAtTime(amp, s + on - r);
      g.gain.linearRampToValueAtTime(0, s + on);
    }
    osc.connect(g);
    if (o.ear === 'both') { g.connect(merger, 0, 0); g.connect(merger, 0, 1); }
    else g.connect(merger, 0, channelOf(o.ear));
    var end = t0 + pulses * (on + off);
    osc.start(t0); osc.stop(end + 0.05);
    osc.onended = function () { try { g.disconnect(); } catch (e) {} };
    return {
      start: t0, end: end,
      stop: function () {
        try { var n = c.currentTime; g.gain.cancelScheduledValues(n); g.gain.setValueAtTime(0, n); osc.stop(n + 0.02); } catch (e) {}
      }
    };
  }

  /* ================= DURUM ================= */
  var S = {
    screen: 'intro',
    answers: { kim: null, yas: null, sikayet: [], sure: null, cihaz: null },
    contact: { ad: '', tel: '', kvkk: false },
    results: { right: {}, left: {} },
    fp: 0, catchN: 0,
    test: null,
    leadSent: false
  };

  var QUESTIONS = [
    { id: 'kim', title: 'Testi kimin için yapıyorsunuz?', type: 'single', two: true,
      options: [['kendim', 'Kendim için'], ['yakinim', 'Bir yakınım için', 'Teste o girecek, siz yardım edeceksiniz']] },
    { id: 'yas', title: 'Testi yapacak kişinin yaşı?', type: 'single', two: true,
      options: [['18-39', '18–39'], ['40-54', '40–54'], ['55-64', '55–64'], ['65-74', '65–74'], ['75+', '75 ve üzeri']] },
    { id: 'sikayet', title: 'Bunlardan hangilerini yaşıyorsunuz?', hint: 'Birden fazla seçebilirsiniz.', type: 'multi',
      options: [
        ['kalabalik', 'Kalabalıkta konuşulanları anlamakta zorlanıyorum'],
        ['tv', 'Televizyonun sesini başkalarından yüksek açıyorum'],
        ['tekrar', 'İnsanlardan sık sık tekrar etmelerini istiyorum'],
        ['telefon', 'Telefonda konuşmayı anlamakta zorlanıyorum'],
        ['cinlama', 'Kulağımda çınlama veya uğultu var'],
        ['tek-kulak', 'Bir kulağım diğerinden daha az duyuyor'],
        ['yok', 'Hiçbiri, sadece kontrol etmek istiyorum']
      ] },
    { id: 'sure', title: 'Bu durumu ne zamandır fark ediyorsunuz?', type: 'single',
      options: [
        ['ani', 'Son birkaç gün içinde aniden başladı'],
        ['6ay', '6 aydan kısa süredir'],
        ['2yil', '6 ay ile 2 yıl arası'],
        ['uzun', '2 yıldan uzun süredir'],
        ['bilmiyorum', 'Emin değilim / bir sorun fark etmedim']
      ] },
    { id: 'cihaz', title: 'Daha önce işitme cihazı kullandınız mı?', type: 'single',
      options: [['hayir', 'Hayır, hiç kullanmadım'], ['simdi', 'Evet, şu an kullanıyorum', 'Testi cihazı çıkararak yapın'], ['eskiden', 'Evet, eskiden kullandım']] }
  ];

  var LABELS = {};
  QUESTIONS.forEach(function (q) { LABELS[q.id] = {}; q.options.forEach(function (o) { LABELS[q.id][o[0]] = o[1]; }); });

  /* ================= YARDIMCILAR ================= */
  var app;
  function $(sel, root) { return (root || app).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || app).querySelectorAll(sel)); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var ICON = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    back: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
    phones: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="5" height="7" rx="2"/><rect x="16" y="14" width="5" height="7" rx="2"/></svg>',
    quiet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M22 9l-6 6M16 9l6 6"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
    wa: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.4.8 3.2.7.5-.1 1.5-.6 1.8-1.2.2-.6.2-1.1.1-1.2l-.6-.3z"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>'
  };

  function phaseOf(screen) {
    if (screen === 'intro' || screen.indexOf('q-') === 0 || screen === 'contact') return 0;
    if (screen === 'prep' || screen === 'lr' || screen === 'volume') return 1;
    if (screen === 'test') return 2;
    return 3;
  }
  function renderPhases() {
    var p = phaseOf(S.screen);
    $all('.it-phase', document).forEach(function (el, i) {
      el.setAttribute('data-state', i < p ? 'done' : i === p ? 'now' : 'todo');
      if (i === p) el.setAttribute('aria-current', 'step'); else el.removeAttribute('aria-current');
    });
  }

  function go(screen) {
    S.screen = screen;
    var html = VIEWS[screen.indexOf('q-') === 0 ? 'question' : screen](screen);
    app.innerHTML = html;
    renderPhases();
    var h = $('h1, h2');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
    window.scrollTo(0, 0);
    if (BIND[screen.indexOf('q-') === 0 ? 'question' : screen]) BIND[screen.indexOf('q-') === 0 ? 'question' : screen](screen);
  }

  /* ================= EKRANLAR ================= */
  var VIEWS = {};
  var BIND = {};

  VIEWS.intro = function () {
    return '<section class="it-screen">' +
      '<div class="it-hero">' +
        '<p class="it-eyebrow">Ücretsiz · Online</p>' +
        '<h1>İşitmenizi evden kontrol edin</h1>' +
        '<p class="it-lead">Kulaklıkla, farklı perdelerde kısık sesler dinleyeceksiniz. Her sesi duyduğunuzda düğmeye basmanız yeterli. Sonunda iki kulağınız için ayrı bir sonuç ve işitme grafiği göreceksiniz.</p>' +
      '</div>' +
      '<div class="it-facts">' +
        '<div class="it-fact"><b>~6 dk</b><span>toplam süre</span></div>' +
        '<div class="it-fact"><b>2 kulak</b><span>ayrı ayrı ölçülür</span></div>' +
        '<div class="it-fact"><b>5 perde</b><span>500–8000 Hz</span></div>' +
      '</div>' +
      '<div class="it-card"><ul class="it-needs">' +
        '<li>' + ICON.phones + '<div><b>Kulaklık takın</b><span>Kablolu kulaklık en iyisidir. Telefon hoparlörüyle test doğru sonuç vermez.</span></div></li>' +
        '<li>' + ICON.quiet + '<div><b>Sessiz bir oda seçin</b><span>Televizyonu kapatın, kapıyı örtün. Telefonunuz sessiz modda olmasın.</span></div></li>' +
        '<li>' + ICON.clock + '<div><b>Acele etmeyin</b><span>Ara vermek isterseniz testi istediğiniz an duraklatabilirsiniz.</span></div></li>' +
      '</ul></div>' +
      '<div class="it-expert"><img src="img/berkant-yuz.webp" width="64" height="64" alt="Uzman Odyolog Berkant Kantur"><p>Sonucunuzu <b>Uzman Odyolog Berkant Kantur</b> değerlendirir ve gerekirse ücretsiz ayrıntılı ölçüm için sizi arar.</p></div>' +
      '<button class="it-btn it-btn--primary it-btn--block" id="it-start" type="button">Teste başla</button>' +
      '<p class="it-note">Bu test tıbbi tanı yerine geçmez. Kulaklık ve cihaz farkları nedeniyle sonuçlar yaklaşıktır. Kesin sonuç için odyometri cihazıyla ölçüm gerekir.</p>' +
    '</section>';
  };
  BIND.intro = function () {
    $('#it-start').addEventListener('click', function () { audio(); go('q-0'); });
  };

  VIEWS.question = function (screen) {
    var i = +screen.slice(2), q = QUESTIONS[i], val = S.answers[q.id];
    var multi = q.type === 'multi';
    var opts = q.options.map(function (o) {
      var on = multi ? val.indexOf(o[0]) > -1 : val === o[0];
      return '<button type="button" class="it-opt" data-v="' + o[0] + '" ' + (multi ? 'role="checkbox" aria-checked="' + on + '"' : 'aria-pressed="' + on + '"') + '>' +
        '<span class="it-opt__box' + (multi ? '' : ' it-opt__box--round') + '">' + ICON.check + '</span>' +
        '<span>' + esc(o[1]) + (o[2] ? '<small>' + esc(o[2]) + '</small>' : '') + '</span></button>';
    }).join('');
    return '<section class="it-screen">' +
      '<div class="it-qhead"><button class="it-back" type="button" id="it-back">' + ICON.back + 'Geri</button><span class="it-count">Soru ' + (i + 1) + ' / ' + QUESTIONS.length + '</span></div>' +
      '<h2>' + esc(q.title) + '</h2>' + (q.hint ? '<p class="it-muted">' + esc(q.hint) + '</p>' : '') +
      '<div class="it-options' + (q.two ? ' it-options--2' : '') + '" role="group" aria-label="' + esc(q.title) + '">' + opts + '</div>' +
      '<div id="it-qextra"></div>' +
      (multi ? '<button class="it-btn it-btn--primary it-btn--block" type="button" id="it-next"' + (val.length ? '' : ' disabled') + '>Devam</button>' : '') +
    '</section>';
  };
  BIND.question = function (screen) {
    var i = +screen.slice(2), q = QUESTIONS[i];
    var next = function () { go(i + 1 < QUESTIONS.length ? 'q-' + (i + 1) : 'contact'); };
    $('#it-back').addEventListener('click', function () { go(i === 0 ? 'intro' : 'q-' + (i - 1)); });
    var showSudden = function () {
      var box = $('#it-qextra');
      if (q.id === 'sure' && S.answers.sure === 'ani') {
        box.innerHTML = '<div class="it-alert it-alert--urgent" role="alert"><b>Ani işitme kaybı acil bir durumdur.</b>' +
          '<span>İşitmeniz son birkaç gün içinde aniden azaldıysa testi beklemeden bugün bir KBB hekimine veya hastanenin acil servisine başvurun. İlk günlerde başlanan tedavi çok daha etkilidir.</span></div>' +
          '<button class="it-btn it-btn--ghost it-btn--block" type="button" id="it-cont">Anladım, teste devam et</button>';
        $('#it-cont').addEventListener('click', next);
        return true;
      }
      box.innerHTML = '';
      return false;
    };
    $all('.it-opt').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-v');
        if (q.type === 'multi') {
          var arr = S.answers[q.id];
          if (v === 'yok') arr = arr.indexOf('yok') > -1 ? [] : ['yok'];
          else {
            arr = arr.filter(function (x) { return x !== 'yok'; });
            var k = arr.indexOf(v); if (k > -1) arr.splice(k, 1); else arr.push(v);
          }
          S.answers[q.id] = arr;
          $all('.it-opt').forEach(function (x) { x.setAttribute('aria-checked', arr.indexOf(x.getAttribute('data-v')) > -1); });
          $('#it-next').disabled = !arr.length;
        } else {
          S.answers[q.id] = v;
          $all('.it-opt').forEach(function (x) { x.setAttribute('aria-pressed', x === b); });
          if (!showSudden()) setTimeout(next, 220);
        }
      });
    });
    if (q.type === 'multi') $('#it-next').addEventListener('click', next);
    showSudden();
  };

  VIEWS.contact = function () {
    var c = S.contact;
    return '<section class="it-screen">' +
      '<div class="it-qhead"><button class="it-back" type="button" id="it-back">' + ICON.back + 'Geri</button><span class="it-count">Son adım</span></div>' +
      '<h2>Sonucunuzu kime iletelim?</h2>' +
      '<p class="it-muted">Uzmanımız test sonucunuzu inceler ve gerekirse sizi arar. Numaranız başka hiçbir amaçla kullanılmaz.</p>' +
      '<form class="it-card" id="it-form" novalidate style="display:grid;gap:18px">' +
        '<div class="it-field"><label for="it-ad">Adınız soyadınız</label>' +
          '<input class="it-input" id="it-ad" name="ad" autocomplete="name" value="' + esc(c.ad) + '" placeholder="Örn. Ayşe Yılmaz"></div>' +
        '<div class="it-field"><label for="it-tel">Telefon numaranız</label>' +
          '<input class="it-input it-input--tel" id="it-tel" name="tel" type="tel" inputmode="tel" autocomplete="tel" value="' + esc(c.tel) + '" placeholder="05__ ___ __ __" aria-describedby="it-tel-err">' +
          '<span class="it-err" id="it-tel-err" hidden></span></div>' +
        '<label class="it-check" for="it-kvkk"><input type="checkbox" id="it-kvkk"' + (c.kvkk ? ' checked' : '') + '>' +
          '<span>Aydınlatma metnini okudum. Bilgilerimin test sonucumun değerlendirilmesi ve benimle iletişime geçilmesi için işlenmesine onay veriyorum.</span></label>' +
        '<span class="it-err" id="it-kvkk-err" hidden>Devam etmek için onay kutusunu işaretleyin.</span>' +
        '<details class="it-kvkk"><summary>Aydınlatma metni (KVKK)</summary><div>' +
          '<p><b>Veri sorumlusu:</b> Trakya İşitme Cihazları, Koca Sinan Mah., 44. Sokak, Öztürk Apt. No: 12/1, 22100 Edirne Merkez / Edirne.</p>' +
          '<p><b>İşlenen veriler:</b> Ad soyad, telefon numarası, anket cevapları ve test sonucu.</p>' +
          '<p><b>Amaç:</b> Test sonucunuzun bir uzman tarafından değerlendirilmesi, size geri dönüş yapılması ve randevu planlanması.</p>' +
          '<p><b>Hukuki sebep:</b> 6698 sayılı KVKK md. 5 ve md. 6 kapsamında açık rızanız.</p>' +
          '<p><b>Aktarım:</b> Verileriniz üçüncü kişilerle paylaşılmaz. Sonucu WhatsApp ile gönderirseniz mesaj WhatsApp altyapısı üzerinden iletilir.</p>' +
          '<p><b>Haklarınız:</b> KVKK md. 11 kapsamındaki haklarınız için ' + esc(CONFIG.PHONE_DISPLAY) + ' numarasından bize ulaşabilirsiniz.</p>' +
        '</div></details>' +
        '<button class="it-btn it-btn--primary it-btn--block" type="submit">Kaydet ve hazırlığa geç</button>' +
      '</form>' +
    '</section>';
  };
  function normPhone(v) {
    var d = String(v).replace(/\D/g, '');
    if (d.indexOf('90') === 0 && d.length === 12) d = d.slice(2);
    if (d.charAt(0) === '0') d = d.slice(1);
    return d;
  }
  function fmtPhone(d) {
    if (d.length !== 10) return d;
    return '0' + d.slice(0, 3) + ' ' + d.slice(3, 6) + ' ' + d.slice(6, 8) + ' ' + d.slice(8);
  }
  BIND.contact = function () {
    var form = $('#it-form'), tel = $('#it-tel'), err = $('#it-tel-err');
    $('#it-back').addEventListener('click', function () { saveContact(); go('q-' + (QUESTIONS.length - 1)); });
    function saveContact() { S.contact.ad = $('#it-ad').value.trim(); S.contact.tel = tel.value.trim(); S.contact.kvkk = $('#it-kvkk').checked; }
    tel.addEventListener('blur', function () { var d = normPhone(tel.value); if (d.length === 10) tel.value = fmtPhone(d); });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      saveContact();
      var d = normPhone(S.contact.tel), ok = true;
      if (!d && !CONFIG.PHONE_REQUIRED) { /* boş geçilebilir */ }
      else if (d.length !== 10 || !/^[2-5]/.test(d)) {
        ok = false; err.hidden = false; tel.setAttribute('aria-invalid', 'true');
        err.textContent = d ? 'Numara eksik ya da hatalı görünüyor. Örnek: 0544 123 45 67' : 'Size dönüş yapabilmemiz için telefon numaranızı yazın.';
      } else { err.hidden = true; tel.removeAttribute('aria-invalid'); S.contact.tel = fmtPhone(d); tel.value = S.contact.tel; }
      $('#it-kvkk-err').hidden = S.contact.kvkk;
      if (!S.contact.kvkk) ok = false;
      if (!ok) { var first = $('[aria-invalid="true"]') || $('#it-kvkk'); first.focus(); return; }
      sendLead('iletisim');
      go('prep');
    });
  };

  VIEWS.prep = function () {
    return '<section class="it-screen">' +
      '<p class="it-eyebrow">Hazırlık · 1 dakika</p>' +
      '<h2>Kulaklığınızı takın</h2>' +
      '<div class="it-card"><ol class="it-steps">' +
        '<li><div><b>Kulaklığı doğru yönde takın</b><span>Çoğu kulaklıkta sağ teki <b>R</b>, sol teki <b>L</b> harfiyle işaretlidir.</span></div></li>' +
        '<li><div><b>Gürültü engelleme açık kalabilir</b><span>Bluetooth kulaklık kullanıyorsanız şarjının dolu olduğundan emin olun.</span></div></li>' +
        '<li><div><b>Bildirimleri kapatın</b><span>Test sırasında gelen bildirim sesleri sonucu bozabilir. Rahatsız Etmeyin modunu açabilirsiniz.</span></div></li>' +
      '</ol></div>' +
      '<button class="it-btn it-btn--primary it-btn--block" type="button" id="it-go">Taktım, devam et</button>' +
    '</section>';
  };
  BIND.prep = function () { $('#it-go').addEventListener('click', function () { audio(); S.lr = { order: Math.random() < .5 ? ['right', 'left'] : ['left', 'right'], idx: 0, swapHits: 0 }; go('lr'); }); };

  // Sağ/sol kontrolü: kulaklığın stereo çalıştığını ve doğru takıldığını doğrular
  VIEWS.lr = function () {
    return '<section class="it-screen">' +
      '<p class="it-eyebrow">Hazırlık · Kulaklık kontrolü ' + (S.lr.idx + 1) + ' / 2</p>' +
      '<h2>Sesi hangi kulağınızda duydunuz?</h2>' +
      '<p class="it-muted">Sesi dinlemek için düğmeye basın. Gerekirse tekrar dinleyebilirsiniz.</p>' +
      '<div class="it-volume"><div class="it-speaker" id="it-spk">' + ICON.speaker + '</div>' +
        '<button class="it-btn it-btn--gold" type="button" id="it-play">Sesi çal</button></div>' +
      '<div class="it-ears">' +
        '<button type="button" class="it-opt" data-v="left" disabled><b>Sol</b><small>kulağımda</small></button>' +
        '<button type="button" class="it-opt" data-v="right" disabled><b>Sağ</b><small>kulağımda</small></button>' +
        '<button type="button" class="it-opt" data-v="both" disabled><b>İki kulağımda</b><small>aynı anda</small></button>' +
        '<button type="button" class="it-opt" data-v="none" disabled><b>Hiç duymadım</b><small>ses gelmedi</small></button>' +
      '</div>' +
      '<p class="it-status" id="it-status" role="status" aria-live="polite"></p>' +
    '</section>';
  };
  BIND.lr = function () {
    var ear = S.lr.order[S.lr.idx], status = $('#it-status');
    function play() {
      var spk = $('#it-spk'); spk.setAttribute('data-on', 'true');
      // ~55 dB HL: rahatça duyulur
      var t = playTone({ freq: 1000, level: 55, ear: ear, pulses: 4 });
      setTimeout(function () { spk.removeAttribute('data-on'); }, t ? (t.end - audio().currentTime) * 1000 + 100 : 300);
      $all('.it-ears .it-opt').forEach(function (b) { b.disabled = false; });
    }
    $('#it-play').addEventListener('click', play);
    $all('.it-ears .it-opt').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-v');
        if (v === ear) {
          status.className = 'it-status it-status--ok'; status.textContent = 'Doğru.';
          setTimeout(function () { S.lr.idx++; if (S.lr.idx < 2) go('lr'); else go('volume'); }, 600);
        } else if (v === 'both') {
          status.className = 'it-status it-status--bad';
          status.textContent = 'Ses iki kulağa birden geliyor. Telefonun hoparlörü yerine kulaklık kullandığınızdan ve tek kulak (mono) ses ayarının kapalı olduğundan emin olun, sonra tekrar dinleyin.';
        } else if (v === 'none') {
          status.className = 'it-status it-status--bad';
          status.textContent = 'Cihazınızın sesini açın, telefonun sessiz modda olmadığını kontrol edin ve tekrar dinleyin.';
        } else {
          S.lr.swapHits++;
          if (S.lr.swapHits >= 2) {
            swapped = !swapped; S.lr.swapHits = 0;
            status.className = 'it-status it-status--ok';
            status.textContent = 'Kulaklığınız ters takılmış olabilir. Bunu hesaba kattık; kulaklığı çevirmenize gerek yok. Sesi tekrar dinleyip kontrol edin.';
          } else {
            status.className = 'it-status it-status--bad';
            status.textContent = 'Ses diğer kulağa gelmeliydi. Kulaklığın R (sağ) ve L (sol) işaretlerine bakıp tekrar dinleyin.';
          }
        }
      });
    });
  };

  VIEWS.volume = function () {
    return '<section class="it-screen">' +
      '<p class="it-eyebrow">Hazırlık · Ses ayarı</p>' +
      '<h2>Ses seviyesini ayarlayın</h2>' +
      '<div class="it-card" style="display:grid;gap:16px">' +
        '<ol class="it-steps">' +
          '<li><div><b>Cihazınızın sesini yaklaşık yarıya getirin</b></div></li>' +
          '<li><div><b>Sesi çalın</b><span>Bu ses, karşınızdaki birinin normal konuşması kadar net ama rahatsız etmeyecek düzeyde olmalı. Değilse cihazınızın ses tuşlarıyla ayarlayın.</span></div></li>' +
          '<li><div><b>Test bitene kadar sesi değiştirmeyin</b></div></li>' +
        '</ol>' +
        '<div class="it-volume"><div class="it-speaker" id="it-spk">' + ICON.speaker + '</div>' +
          '<button class="it-btn it-btn--gold" type="button" id="it-loop" aria-pressed="false">Referans sesi çal</button></div>' +
      '</div>' +
      '<button class="it-btn it-btn--primary it-btn--block" type="button" id="it-go">Ses rahat ve net, testi başlat</button>' +
      '<p class="it-small">Test boyunca sesler giderek kısılacak; bazılarını duymamanız normaldir.</p>' +
    '</section>';
  };
  var loopTimer = null;
  function stopLoop() { if (loopTimer) { clearInterval(loopTimer); loopTimer = null; } }
  BIND.volume = function () {
    var btn = $('#it-loop'), spk = $('#it-spk');
    function once() { playTone({ freq: 1000, level: CAL_DBHL, ear: 'both', pulses: 3 }); }
    btn.addEventListener('click', function () {
      if (loopTimer) { stopLoop(); btn.setAttribute('aria-pressed', 'false'); btn.textContent = 'Referans sesi çal'; spk.removeAttribute('data-on'); return; }
      once(); loopTimer = setInterval(once, 2200);
      btn.setAttribute('aria-pressed', 'true'); btn.textContent = 'Durdur'; spk.setAttribute('data-on', 'true');
    });
    $('#it-go').addEventListener('click', function () { stopLoop(); startTest(); });
  };

  /* ================= TEST ================= */
  VIEWS.test = function () {
    return '<section class="it-screen it-test">' +
      '<p class="it-test__ear" id="it-ear" data-ear="right"><span>●</span><span id="it-ear-t">Sağ kulak</span></p>' +
      '<h2 style="font-size:1.35rem">Sesi duyduğunuz anda basın</h2>' +
      '<p class="it-muted" style="max-width:34ch">Çok kısık da olsa, duyduğunuzdan emin olduğunuz anda basın. Duymuyorsanız beklemeniz yeterli.</p>' +
      '<button type="button" class="it-press" id="it-press" aria-describedby="it-listen">Duydum<small>veya boşluk tuşu</small></button>' +
      '<p class="it-listen" id="it-listen" aria-live="off">Dinleyin…</p>' +
      '<div class="it-bar" role="progressbar" aria-label="Test ilerlemesi" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i id="it-bar"></i></div>' +
      '<div class="it-test__meta"><span id="it-hz">1000 Hz</span><span id="it-pct">%0</span></div>' +
      '<button class="it-btn it-btn--ghost" type="button" id="it-pause">Duraklat</button>' +
      '<div class="it-pause" id="it-pausebox" hidden><div class="it-card"><h3>Test duraklatıldı</h3>' +
        '<p class="it-muted">Hazır olduğunuzda kaldığınız yerden devam edin. Ses ayarını değiştirmeyin.</p>' +
        '<button class="it-btn it-btn--primary" type="button" id="it-resume">Devam et</button>' +
        '<button class="it-btn it-btn--ghost" type="button" id="it-quit">Testi bitir</button></div></div>' +
    '</section>';
  };

  var wakeLock = null;
  function keepAwake() { try { if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }, function () {}); } catch (e) {} }

  function startTest() {
    S.results = { right: {}, left: {} }; S.fp = 0; S.catchN = 0;
    S.test = { paused: false, stopped: false, onPress: null, abort: null, done: 0, total: CONFIG.EARS.length * CONFIG.FREQS.length };
    go('test');
    keepAwake();
    var t = S.test, press = $('#it-press');
    function hit(e) {
      if (e) e.preventDefault();
      if (t.paused || t.stopped) return;
      press.setAttribute('data-flash', 'true'); setTimeout(function () { press.removeAttribute('data-flash'); }, 160);
      if (t.onPress) t.onPress();
    }
    press.addEventListener('pointerdown', hit);
    press.addEventListener('keydown', function (e) { if (e.key === 'Enter') hit(e); });
    t.keyHandler = function (e) { if ((e.code === 'Space' || e.key === ' ') && S.screen === 'test') { hit(e); } };
    document.addEventListener('keydown', t.keyHandler);
    t.visHandler = function () { if (document.hidden && S.screen === 'test') pause(); };
    document.addEventListener('visibilitychange', t.visHandler);
    function pause() { if (t.paused) return; t.paused = true; if (t.abort) t.abort(); $('#it-pausebox').hidden = false; $('#it-resume').focus(); }
    $('#it-pause').addEventListener('click', pause);
    $('#it-resume').addEventListener('click', function () { $('#it-pausebox').hidden = true; t.paused = false; audio(); if (t.resume) t.resume(); press.focus(); });
    $('#it-quit').addEventListener('click', function () { t.stopped = true; t.paused = false; $('#it-pausebox').hidden = true; if (t.resume) t.resume(); });
    runAll().then(finishTest, function (err) { if (err !== 'stop') console.error(err); finishTest(); });
  }

  function waitIfPaused() {
    var t = S.test;
    if (!t.paused) return Promise.resolve();
    return new Promise(function (r) { t.resume = function () { t.resume = null; r(); }; });
  }

  function runTrial(freq, level, ear, silent) {
    var t = S.test, c = audio();
    return new Promise(function (resolve) {
      var delay = 0.6 + Math.random() * 1.2;
      var tStart = c.currentTime + 0.05 + delay;
      var tone = silent ? null : playTone({ freq: freq, level: level, ear: ear, delay: delay });
      var windowEnd = tStart + PULSES * (ON + OFF) + 1.4;
      var done = false, heard = false, early = 0;
      t.onPress = function () { if (c.currentTime < tStart + 0.08) { early++; return; } heard = true; finish(false); };
      t.abort = function () { finish(true); };
      var timer = setInterval(function () { if (c.currentTime >= windowEnd) finish(false); }, 40);
      function finish(aborted) {
        if (done) return; done = true;
        clearInterval(timer); t.onPress = null; t.abort = null;
        if (tone && (aborted || heard)) tone.stop();
        resolve({ heard: heard, early: early, aborted: aborted });
      }
    });
  }

  function median(a) { var s = a.slice().sort(function (x, y) { return x - y; }); return s[Math.floor((s.length - 1) / 2)]; }

  // Basitleştirilmiş Hughson-Westlake: duyulursa 10 dB in, duyulmazsa 5 dB çık.
  // Çıkışta (önce duyulmamış, şimdi duyulmuş) aynı seviyede 2 yanıt = eşik.
  async function measure(ear, freq, start) {
    var t = S.test, MAX = maxDb(freq);
    var level = Math.min(MAX, start), prevHeard = null, everHeard = false;
    var asc = {}, ascList = [], trials = 0, maxMiss = 0;
    while (true) {
      await waitIfPaused();
      if (t.stopped) throw 'stop';
      if (trials > 1 && Math.random() < CONFIG.CATCH_RATE) {
        var cr = await runTrial(freq, 0, ear, true);
        if (!cr.aborted) { S.catchN++; if (cr.heard) S.fp++; }
        await sleep(350 + Math.random() * 400);
        continue;
      }
      var r = await runTrial(freq, level, ear, false);
      if (r.aborted) continue;
      if (r.early >= 2) S.fp++;
      trials++;
      if (r.heard) {
        everHeard = true;
        if (prevHeard === false) {
          asc[level] = (asc[level] || 0) + 1; ascList.push(level);
          if (asc[level] >= 2) return level;
          if (ascList.length >= 4) return median(ascList);
        }
        if (level <= MIN_DB) return MIN_DB;
        level = Math.max(MIN_DB, level - 10);
      } else {
        if (level >= MAX) { maxMiss++; if (maxMiss >= 2) return null; }
        level = Math.min(MAX, level + (everHeard ? 5 : 10));
      }
      prevHeard = r.heard;
      if (trials >= 18) return ascList.length ? median(ascList) : (everHeard ? level : null);
      await sleep(350 + Math.random() * 450);
    }
  }

  function setTestUI(ear, freq) {
    var e = $('#it-ear'); if (!e) return;
    e.setAttribute('data-ear', ear);
    $('#it-ear-t').textContent = ear === 'right' ? 'Sağ kulak' : 'Sol kulak';
    $('#it-hz').textContent = freq + ' Hz';
    var pct = Math.round(S.test.done / S.test.total * 100);
    $('#it-bar').style.width = pct + '%';
    $('.it-bar').setAttribute('aria-valuenow', pct);
    $('#it-pct').textContent = '%' + pct;
  }

  async function runAll() {
    for (var e = 0; e < CONFIG.EARS.length; e++) {
      var ear = CONFIG.EARS[e], prev = null;
      if (e > 0) {
        var l = $('#it-listen'); if (l) l.textContent = 'Şimdi diğer kulak';
        setTestUI(ear, CONFIG.FREQS[0]);
        await sleep(1800);
        if (l) l.textContent = 'Dinleyin…';
      }
      for (var f = 0; f < CONFIG.FREQS.length; f++) {
        var freq = CONFIG.FREQS[f];
        setTestUI(ear, freq);
        var start = prev == null ? 40 : Math.max(20, Math.min(50, prev + 15));
        var th = await measure(ear, freq, start);
        S.results[ear][freq] = th == null ? { nr: true, db: maxDb(freq) } : { db: th };
        if (th != null) prev = th;
        S.test.done++;
        setTestUI(ear, freq);
        await sleep(500);
      }
    }
  }

  function finishTest() {
    var t = S.test;
    document.removeEventListener('keydown', t.keyHandler);
    document.removeEventListener('visibilitychange', t.visHandler);
    try { if (wakeLock) wakeLock.release(); } catch (e) {}
    var any = Object.keys(S.results.right).length || Object.keys(S.results.left).length;
    S.partial = t.stopped;
    if (!any) { go('intro'); return; }
    go('result');
    sendLead('sonuc');
  }

  /* ================= YORUM ================= */
  var GRADES = [
    [25, 'Normal aralık', 'normal'],
    [40, 'Hafif düzeyde azalma', 'hafif'],
    [55, 'Orta düzeyde azalma', 'orta'],
    [70, 'Orta-ileri düzeyde azalma', 'orta-ileri'],
    [999, 'İleri düzeyde azalma', 'ileri']
  ];
  function grade(db) { for (var i = 0; i < GRADES.length; i++) if (db <= GRADES[i][0]) return { label: GRADES[i][1], key: GRADES[i][2], idx: i }; }
  function pta(ear) {
    var r = S.results[ear], fs = [500, 1000, 2000, 4000], sum = 0, n = 0;
    fs.forEach(function (f) { if (r[f]) { sum += r[f].nr ? r[f].db + 5 : r[f].db; n++; } });
    return n ? Math.round(sum / n) : null;
  }
  function analyze() {
    var out = { right: pta('right'), left: pta('left'), notes: [], level: 'ok' };
    var gR = out.right != null ? grade(out.right) : null, gL = out.left != null ? grade(out.left) : null;
    out.gR = gR; out.gL = gL;
    var worst = Math.max(gR ? gR.idx : 0, gL ? gL.idx : 0);
    if (worst >= 2) out.level = 'urgent'; else if (worst === 1) out.level = 'warn';
    if (out.right != null && out.left != null && Math.abs(out.right - out.left) >= 15) {
      out.notes.push('İki kulağınız arasında belirgin fark görünüyor (' + Math.abs(out.right - out.left) + ' dB). Tek taraflı işitme azalması bir KBB hekimi tarafından muayene edilmelidir.');
      if (out.level === 'ok') out.level = 'warn';
    }
    ['right', 'left'].forEach(function (ear) {
      var r = S.results[ear], p = ear === 'right' ? out.right : out.left;
      var hi = Math.max(r[4000] ? r[4000].db : 0, r[8000] ? r[8000].db : 0);
      if (p != null && p <= 25 && hi >= 35) {
        out.notes.push((ear === 'right' ? 'Sağ' : 'Sol') + ' kulağınızda tiz (ince) seslerde azalma görünüyor. Bu durum genellikle ilk olarak kalabalık ortamlarda konuşmaları anlamayı zorlaştırır.');
        if (out.level === 'ok') out.level = 'warn';
      }
    });
    var sk = S.answers.sikayet || [];
    if (out.level === 'ok' && sk.length && sk.indexOf('yok') < 0) {
      out.notes.push('Ölçüm normal aralıkta olsa da belirttiğiniz şikâyetler (' + sk.map(function (k) { return LABELS.sikayet[k].toLowerCase(); }).join('; ') + ') için ayrıntılı bir ölçüm faydalı olabilir.');
    }
    if (sk.indexOf('cinlama') > -1) out.notes.push('Kulak çınlaması için ayrı bir değerlendirme (tinnitus testi) yapılabilir.');
    if (S.catchN && S.fp >= 2) out.notes.push('Test sırasında ses yokken de birkaç kez düğmeye basıldı. Sonuçlar olduğundan iyi görünüyor olabilir.');
    if (S.partial) out.notes.push('Test yarıda bırakıldı; sonuç sadece ölçülebilen perdeleri gösteriyor.');
    return out;
  }

  /* ================= ODYOGRAM (SVG) ================= */
  function audiogram() {
    var W = 440, H = 380, L = 46, R = 12, T = 34, B = 34;
    var fs = CONFIG.CHART_FREQS, dbMin = -10, dbMax = 80;
    var x = function (f) { return L + (W - L - R) * (Math.log2(f / fs[0]) / Math.log2(fs[fs.length - 1] / fs[0])); };
    var y = function (db) { return T + (H - T - B) * ((db - dbMin) / (dbMax - dbMin)); };
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="İşitme grafiği (odyogram): sağ kulak kırmızı daire, sol kulak mavi çarpı ile gösterilir">';
    var bands = [[-10, 25, '#E3F1E7'], [25, 40, '#F6F0D6'], [40, 55, '#F7E6CC'], [55, 70, '#F5D9C6'], [70, 80, '#F1CDBF']];
    bands.forEach(function (b) { s += '<rect x="' + L + '" y="' + y(b[0]) + '" width="' + (W - L - R) + '" height="' + (y(b[1]) - y(b[0])) + '" fill="' + b[2] + '"/>'; });
    var names = [[7.5, 'Normal'], [32.5, 'Hafif'], [47.5, 'Orta'], [62.5, 'Orta-ileri'], [75, 'İleri']];
    names.forEach(function (n) { s += '<text x="' + (W - R - 6) + '" y="' + (y(n[0]) + 4) + '" text-anchor="end" font-size="13" fill="#4B5B5C" font-family="Atkinson Hyperlegible Next, sans-serif">' + n[1] + '</text>'; });
    for (var d = dbMin; d <= dbMax; d += 10) {
      s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(d) + '" y2="' + y(d) + '" stroke="#1C2A2B" stroke-opacity=".12"/>';
      s += '<text x="' + (L - 8) + '" y="' + (y(d) + 4) + '" text-anchor="end" font-size="14" fill="#4B5B5C" font-family="Atkinson Hyperlegible Next, sans-serif">' + d + '</text>';
    }
    fs.forEach(function (f) {
      s += '<line x1="' + x(f) + '" x2="' + x(f) + '" y1="' + T + '" y2="' + (H - B) + '" stroke="#1C2A2B" stroke-opacity=".12"/>';
      s += '<text x="' + x(f) + '" y="' + (T - 10) + '" text-anchor="middle" font-size="15" fill="#1C2A2B" font-weight="700" font-family="Atkinson Hyperlegible Next, sans-serif">' + (f >= 1000 ? (f / 1000) + 'k' : f) + '</text>';
    });
    s += '<text x="' + (L + (W - L - R) / 2) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="13" fill="#4B5B5C" font-family="Atkinson Hyperlegible Next, sans-serif">Perde (Hz) · kalından inceye</text>';
    s += '<text transform="translate(14 ' + (T + (H - T - B) / 2) + ') rotate(-90)" text-anchor="middle" font-size="13" fill="#4B5B5C" font-family="Atkinson Hyperlegible Next, sans-serif">İşitme eşiği (dB)</text>';
    [['right', '#C2362B', -4], ['left', '#2357B8', 4]].forEach(function (e) {
      var r = S.results[e[0]], pts = fs.filter(function (f) { return r[f]; }).map(function (f) { return [x(f) + e[2], y(Math.min(dbMax, r[f].db)), r[f].nr]; });
      if (pts.length > 1) s += '<polyline fill="none" stroke="' + e[1] + '" stroke-width="2.5" stroke-linejoin="round" points="' + pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' ') + '"' + (e[0] === 'left' ? ' stroke-dasharray="6 4"' : '') + '/>';
      pts.forEach(function (p) {
        if (e[0] === 'right') s += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="7" fill="#FFFDF9" stroke="' + e[1] + '" stroke-width="3"/>';
        else s += '<path d="M' + (p[0] - 6) + ' ' + (p[1] - 6) + 'l12 12M' + (p[0] + 6) + ' ' + (p[1] - 6) + 'l-12 12" stroke="' + e[1] + '" stroke-width="3" stroke-linecap="round" fill="none"/>';
        if (p[2]) s += '<path d="M' + p[0] + ' ' + (p[1] + 10) + 'v12m-5 -5l5 5 5 -5" stroke="' + e[1] + '" stroke-width="2.2" fill="none" stroke-linecap="round"/>';
      });
    });
    return s + '</svg>';
  }

  function fmtDb(r) { return r ? (r.nr ? '>' + r.db : String(r.db)) : '–'; }

  VIEWS.result = function () {
    var a = analyze();
    var head = {
      ok: ['İşitmeniz normal aralıkta görünüyor', 'Bu testte iki kulağınız da sesleri normal sınırlarda duydu.'],
      warn: ['İşitmenizde hafif bir azalma olabilir', 'Bazı seslerde beklenenden daha yüksek seviyeye ihtiyaç duydunuz. Ayrıntılı bir ölçüm durumu netleştirir.'],
      urgent: ['İşitmenizde belirgin bir azalma görünüyor', 'Kısa süre içinde bir uzmana kesin ölçüm yaptırmanızı öneriyoruz. İşitme kaybı ne kadar erken ele alınırsa uyum o kadar kolay olur.']
    }[a.level];
    var box = function (ear, p, g) {
      return '<div class="it-earbox it-earbox--' + ear + '"><span class="it-earbox__h">' + (ear === 'right' ? 'Sağ kulak' : 'Sol kulak') + '</span>' +
        '<span class="it-earbox__v">' + (p == null ? '–' : p) + ' <small>dB ort.</small></span>' +
        '<span class="it-earbox__t">' + (g ? g.label : 'Ölçülmedi') + '</span></div>';
    };
    var rows = ['right', 'left'].map(function (ear) {
      return '<tr><td>' + (ear === 'right' ? '<span style="color:var(--ear-right)">●</span> Sağ' : '<span style="color:var(--ear-left)">✕</span> Sol') + '</td>' +
        CONFIG.CHART_FREQS.map(function (f) { return '<td>' + fmtDb(S.results[ear][f]) + '</td>'; }).join('') + '</tr>';
    }).join('');
    var sudden = S.answers.sure === 'ani' ? '<div class="it-alert it-alert--urgent"><b>Ani işitme kaybı acil bir durumdur.</b><span>Bugün bir KBB hekimine veya hastanenin acil servisine başvurun.</span></div>' : '';
    return '<section class="it-screen">' +
      '<p class="it-eyebrow">Sonucunuz' + (S.contact.ad ? ' · ' + esc(S.contact.ad) : '') + '</p>' +
      sudden +
      '<div class="it-verdict"><h1 style="font-size:clamp(1.8rem,5.4vw,2.4rem)">' + head[0] + '</h1><p class="it-lead">' + head[1] + '</p></div>' +
      '<div class="it-ears-sum">' + box('right', a.right, a.gR) + box('left', a.left, a.gL) + '</div>' +
      '<div class="it-card" style="display:grid;gap:12px"><h3>İşitme grafiğiniz</h3>' +
        '<p class="it-small">Noktalar ne kadar aşağıdaysa o perdeyi duymak için o kadar yüksek ses gerekti. Yeşil alan normal işitmedir.</p>' +
        '<div class="it-chart">' + audiogram() + '</div>' +
        '<div class="it-legend"><span><svg width="18" height="18" viewBox="0 0 18 18"><circle cx="9" cy="9" r="6" fill="#FFFDF9" stroke="#C2362B" stroke-width="3"/></svg>Sağ kulak</span>' +
          '<span><svg width="18" height="18" viewBox="0 0 18 18"><path d="M3 3l12 12M15 3L3 15" stroke="#2357B8" stroke-width="3" stroke-linecap="round"/></svg>Sol kulak</span>' +
          '<span>↓ En yüksek seste de duyulmadı</span></div>' +
        '<p class="it-small">Her perde için duyduğunuz en kısık ses (dB):</p><div class="it-chart"><table class="it-table"><thead><tr><th>Hz →</th>' + CONFIG.CHART_FREQS.map(function (f) { return '<th>' + f + '</th>'; }).join('') + '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '</div>' +
      (a.notes.length ? '<div class="it-card" style="display:grid;gap:10px"><h3>Dikkat çeken noktalar</h3><ul class="it-findings">' + a.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul></div>' : '') +
      '<div class="it-cta">' +
        '<h2>' + (a.level === 'ok' ? 'Sonucunuzu uzmanımıza gönderin' : 'Ücretsiz ayrıntılı ölçüm için randevu alın') + '</h2>' +
        '<p>Sonucunuz WhatsApp mesajına hazır olarak eklenir; tek yapmanız gereken göndermek. Uzman Odyolog Berkant Kantur sonucu inceleyip size dönüş yapar.</p>' +
        '<a class="it-btn it-btn--wa it-btn--block" id="it-wa" target="_blank" rel="noopener" href="' + waLink(a) + '">' + ICON.wa + 'Sonucumu WhatsApp\'tan gönder</a>' +
        '<div class="it-actions"><a class="it-btn it-btn--ghost" href="tel:' + CONFIG.PHONE_TEL + '">' + ICON.phone + 'Arayın</a><span class="it-num">' + CONFIG.PHONE_DISPLAY + '</span></div>' +
        '<p>Pazartesi–Cumartesi 09:00–19:00 · Koca Sinan Mah., 44. Sokak No: 12/1, Edirne Merkez</p>' +
      '</div>' +
      '<p class="it-note">Bu online test tıbbi tanı yerine geçmez. Kulaklık, cihaz ve ortam farkları nedeniyle değerler yaklaşıktır. Kesin sonuç için kalibre edilmiş odyometri cihazıyla ölçüm gerekir.</p>' +
      '<button class="it-btn it-btn--ghost it-btn--block" type="button" id="it-again">Testi yeniden yap</button>' +
    '</section>';
  };
  BIND.result = function () {
    $('#it-again').addEventListener('click', function () { go('volume'); });
  };

  /* ================= GÖNDERİM ================= */
  function summaryLines(a) {
    var A = S.answers, lines = [];
    lines.push('Merhaba, trakyaisitme.com üzerinden online işitme testini yaptım.');
    lines.push('');
    if (S.contact.ad) lines.push('Ad Soyad: ' + S.contact.ad);
    if (S.contact.tel) lines.push('Telefon: ' + S.contact.tel);
    if (A.kim) lines.push('Kimin için: ' + LABELS.kim[A.kim]);
    if (A.yas) lines.push('Yaş: ' + LABELS.yas[A.yas]);
    if (A.sikayet.length) lines.push('Şikâyetler: ' + A.sikayet.map(function (k) { return LABELS.sikayet[k]; }).join('; '));
    if (A.sure) lines.push('Ne zamandır: ' + LABELS.sure[A.sure]);
    if (A.cihaz) lines.push('Cihaz kullanımı: ' + LABELS.cihaz[A.cihaz]);
    if (a) {
      lines.push('');
      lines.push('Test sonucu (dB, ' + CONFIG.CHART_FREQS.join('/') + ' Hz):');
      ['right', 'left'].forEach(function (ear) {
        var p = ear === 'right' ? a.right : a.left, g = ear === 'right' ? a.gR : a.gL;
        lines.push((ear === 'right' ? 'Sağ: ' : 'Sol: ') + CONFIG.CHART_FREQS.map(function (f) { return fmtDb(S.results[ear][f]); }).join(' / ') +
          (p != null ? ' → ort. ' + p + ' dB (' + g.label.toLowerCase() + ')' : ''));
      });
      if (S.fp >= 2) lines.push('Not: Test sırasında ses yokken ' + S.fp + ' kez düğmeye basıldı.');
      lines.push('');
      lines.push('Ayrıntılı ölçüm için randevu almak istiyorum.');
    }
    return lines;
  }
  function waLink(a) { return 'https://wa.me/' + CONFIG.WA_NUMBER + '?text=' + encodeURIComponent(summaryLines(a).join('\n')); }

  function sendLead(stage) {
    if (!CONFIG.LEAD_ENDPOINT) return;
    var a = stage === 'sonuc' ? analyze() : null;
    var payload = {
      kaynak: 'online-isitme-testi', asama: stage, tarih: new Date().toISOString(),
      ad: S.contact.ad, telefon: S.contact.tel, kvkkOnay: S.contact.kvkk,
      kimIcin: LABELS.kim[S.answers.kim] || '', yas: LABELS.yas[S.answers.yas] || '',
      sikayetler: S.answers.sikayet.map(function (k) { return LABELS.sikayet[k]; }).join('; '),
      sure: LABELS.sure[S.answers.sure] || '', cihaz: LABELS.cihaz[S.answers.cihaz] || '',
      sagOrt: a ? a.right : '', solOrt: a ? a.left : '',
      sag: a ? CONFIG.CHART_FREQS.map(function (f) { return fmtDb(S.results.right[f]); }).join('/') : '',
      sol: a ? CONFIG.CHART_FREQS.map(function (f) { return fmtDb(S.results.left[f]); }).join('/') : '',
      sonuc: a ? (a.level === 'ok' ? 'normal' : a.level === 'warn' ? 'hafif/şüpheli' : 'belirgin') : ''
    };
    try {
      fetch(CONFIG.LEAD_ENDPOINT, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) }).catch(function () {});
    } catch (e) {}
  }

  /* ================= ÖRNEK SONUÇ (#ornek-sonuc) =================
     Tasarımı görmek için testi yapmadan örnek bir sonuç ekranı açar. */
  function demo() {
    S.answers = { kim: 'yakinim', yas: '65-74', sikayet: ['kalabalik', 'tv'], sure: '2yil', cihaz: 'hayir' };
    S.contact = { ad: 'Örnek Hasta', tel: '0544 000 00 00', kvkk: true };
    S.fp = 0; S.catchN = 0; S.partial = false;
    S.results = {
      right: { 500: { db: 20 }, 1000: { db: 25 }, 2000: { db: 35 }, 4000: { db: 50 }, 8000: { db: 55 } },
      left: { 500: { db: 15 }, 1000: { db: 20 }, 2000: { db: 30 }, 4000: { db: 45 }, 8000: { nr: true, db: maxDb(8000) } }
    };
    go('result');
  }

  /* ================= BAŞLAT ================= */
  function init() {
    app = document.getElementById('it-app');
    if (!app) return;
    if (!(window.AudioContext || window.webkitAudioContext)) {
      app.innerHTML = '<section class="it-screen"><h1>Tarayıcınız bu testi desteklemiyor</h1><p class="it-lead">Lütfen Chrome, Safari veya Edge\'in güncel bir sürümüyle tekrar deneyin ya da bizi arayın: ' + CONFIG.PHONE_DISPLAY + '</p></section>';
      return;
    }
    if (location.hash === '#ornek-sonuc') demo(); else go('intro');
    window.addEventListener('hashchange', function () { if (location.hash === '#ornek-sonuc') demo(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
