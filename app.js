let vocabularyPool = [];
let activeList = [];
let wrongAnswers = [];
let currentIndex = 0;
let currentStage = 1; 
let isShowingResolution = false;

// 1. Bild verarbeiten und OCR starten
async function handleImageUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        const img = document.getElementById('preview-img');
        img.src = e.target.result;
        img.style.display = 'inline-block';
    };
    reader.readAsDataURL(file);

    const statusText = document.getElementById('status-text');
    statusText.style.display = 'block';
    statusText.innerText = "⏳ Analysiere Bildstruktur (kann kurz dauern)...";

    try {
        const result = await Tesseract.recognize(file, 'deu+eng', {
            logger: m => {
                if(m.status === 'recognizing text') {
                    statusText.innerText = `⏳ Text wird extrahiert: ${Math.round(m.progress * 100)}%`;
                }
            }
        });

        statusText.innerText = "✅ Scan erfolgreich!";
        processOcrText(result.data.text);

    } catch (error) {
        console.error(error);
        statusText.innerText = "❌ Fehler beim Lesen des Bildes.";
    }
}

// 2. Erkannten Text aufteilen und säubern
function processOcrText(text) {
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 3);
    vocabularyPool = [];
    
    const container = document.getElementById('scanned-container');
    container.innerHTML = '';

    lines.forEach((line) => {
        let cleanLine = line.replace(/\[.*?\]/g, ''); 
        let parts = cleanLine.split(/\s{2,}|\t|;|—/); 
        
        if (parts.length >= 2) {
            let enWort = parts[0].trim();
            let deWort = parts[1].trim();
            let satz = parts.slice(2).join(" ").trim() || `Context sentence for ${enWort}`;

            let vocItem = {
                de: deWort,
                en: enWort.replace(/^to\s+/i, ''), 
                fullEn: enWort,
                sentence: satz
            };
            
            vocabularyPool.push(vocItem);

            let row = document.createElement('div');
            row.className = 'scanned-item';
            row.innerHTML = `<span><strong>${vocItem.fullEn}</strong> ➔ ${vocItem.de}</span>`;
            container.appendChild(row);
        }
    });

    if(vocabularyPool.length > 0) {
        document.getElementById('scanned-box').style.display = 'block';
        document.getElementById('start-btn').style.display = 'inline-block';
    } else {
        document.getElementById('status-text').innerText = "⚠ Keine klare Struktur erkannt. Versuche einen schärferen Screenshot.";
    }
}

// 3. Trainer starten
function initTrainer() {
    if(vocabularyPool.length === 0) return;
    
    activeList = [...vocabularyPool];
    currentIndex = 0;
    currentStage = 1;
    wrongAnswers = [];

    document.getElementById('scan-screen').style.display = 'none';
    document.getElementById('trainer-screen').style.display = 'block';
    
    showQuestion();
}

// 4. Wort anzeigen
function showQuestion() {
    isShowingResolution = false;
    document.getElementById('user-input').value = '';
    document.getElementById('feedback-display').innerText = '';
    document.getElementById('sentence-box').style.display = 'none';
    document.getElementById('action-btn').innerText = "Antwort prüfen";
    
    let currentItem = activeList[currentIndex];
    document.getElementById('stats-display').innerText = `Vokabel ${currentIndex + 1} von ${activeList.length}`;

    if (currentStage === 1 || currentStage === 2) {
        document.getElementById('phase-title').innerText = currentStage === 1 ? "Runde 1: Deutsch ➔ Englisch" : "Fehler-Wiederholung";
        document.getElementById('question-display').innerText = currentItem.de;
    } else if (currentStage === 3) {
        document.getElementById('phase-title').innerText = "Runde 2: Lückentext (Satz ➔ Wort)";
        document.getElementById('question-display').innerText = "Ergänze das Wort im Satz:";
        
        let regex = new RegExp(currentItem.en, "gi");
        let blanked = currentItem.sentence.replace(regex, "_______");
        if(!blanked.includes("_______")) {
            blanked = `Satz-Kontext: ${currentItem.sentence} (Wort: _______)`;
        }
        document.getElementById('sentence-box').innerText = blanked;
        document.getElementById('sentence-box').style.display = 'block';
    }
}

// 5. Antwort prüfen
function checkAnswer() {
    let userAns = document.getElementById('user-input').value.trim().toLowerCase();
    let currentItem = activeList[currentIndex];
    let feedback = document.getElementById('feedback-display');

    if (!isShowingResolution) {
        let target = currentItem.en.toLowerCase();
        let isCorrect = (userAns === target || userAns === "to " + target);
        
        if (isCorrect) {
            feedback.innerHTML = "<span class='correct'>Richtig! 🎉</span>";
        } else {
            feedback.innerHTML = `<span class='wrong'>Falsch! ❌</span><br>Lösung: <strong>${currentItem.fullEn}</strong>`;
            if (!wrongAnswers.includes(currentItem)) {
                wrongAnswers.push(currentItem);
            }
        }

        document.getElementById('sentence-box').innerHTML = `<strong>Spalte 3 / Satz:</strong> ${currentItem.sentence}`;
        document.getElementById('sentence-box').style.display = 'block';
        
        document.getElementById('action-btn').innerText = "Weiter";
        isShowingResolution = true;
    } else {
        currentIndex++;
        if (currentIndex < activeList.length) {
            showQuestion();
        } else {
            handleStageTransition();
        }
    }
}

// 6. Phasenwechsel
function handleStageTransition() {
    if (currentStage === 1) {
        if (wrongAnswers.length > 0) {
            alert("Runde 1 beendet! Wir wiederholen jetzt direkt deine Fehler.");
            activeList = [...wrongAnswers];
            wrongAnswers = [];
            currentIndex = 0;
            currentStage = 2;
            showQuestion();
        } else {
            startRound2();
        }
    } else if (currentStage === 2) {
        if (wrongAnswers.length > 0) {
            alert("Ein paar Wackelkandidaten gibt es noch. Noch einmal!");
            activeList = [...wrongAnswers];
            wrongAnswers = [];
            currentIndex = 0;
            showQuestion();
        } else {
            startRound2();
        }
    } else if (currentStage === 3) {
        alert("Perfekt gelernt! Du bist bereit für deinen KI-Test! 🎓");
        location.reload();
    }
}

function startRound2() {
    alert("Super! Jetzt startet Runde 2: Du siehst den Satz und musst das englische Wort eintragen!");
    activeList = [...vocabularyPool];
    currentIndex = 0;
    currentStage = 3;
    showQuestion();
}

function handleKeyPress(event) {
    if (event.key === 'Enter') {
        checkAnswer();
    }
}
