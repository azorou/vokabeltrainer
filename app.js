let vocabularyPool = [];
let activeList = [];
let wrongAnswers = [];
let currentIndex = 0;
let currentStage = 1; 
let isShowingResolution = false;

// Verarbeitet den gleichzeitigen Upload mehrerer Bilder
async function handleBatchUpload(event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    // Reset alter Daten vor neuem Batch-Scan
    vocabularyPool = [];
    document.getElementById('scanned-container').innerHTML = '';
    const previewContainer = document.getElementById('preview-box');
    previewContainer.innerHTML = '';
    
    const statusText = document.getElementById('status-text');
    statusText.style.display = 'block';
    statusText.style.color = '#e67e22';

    // Zeige Miniatur-Vorschauen für alle ausgewählten Bilder an
    for (let i = 0; i < files.length; i++) {
        const reader = new FileReader();
        reader.onload = function(e) {
            const img = document.createElement('img');
            img.src = e.target.result;
            img.className = 'preview-img';
            previewContainer.appendChild(img);
        };
        reader.readAsDataURL(files[i]);
    }

    statusText.innerText = "⏳ Initialisiere KI-Engine...";

    // Gehe alle hochgeladenen Bilder nacheinander durch
    for (let i = 0; i < files.length; i++) {
        statusText.innerText = `⏳ Scanne Bild ${i + 1} von ${files.length}...`;
        
        try {
            const { data: { text } } = await Tesseract.recognize(files[i], 'deu+eng', {
                logger: m => {
                    if (m.status === 'recognizing text') {
                        statusText.innerText = `⏳ Bild ${i + 1}/${files.length}: ${Math.round(m.progress * 100)}%`;
                    }
                }
            });
            processOcrTextChunk(text);
        } catch (error) {
            console.error(`Fehler bei Bild ${i + 1}:`, error);
            statusText.style.color = '#e74c3c';
            statusText.innerText = `❌ Fehler bei Bild ${i + 1}. Scanne weiter...`;
        }
    }

    // Abschluss-Check
    if (vocabularyPool.length > 0) {
        statusText.style.color = '#2ecc71';
        statusText.innerText = `✅ Alle ${files.length} Bilder erfolgreich verarbeitet!`;
        document.getElementById('scanned-box').style.display = 'block';
        document.getElementById('start-btn').style.display = 'inline-block';
    } else {
        statusText.style.color = '#e74c3c';
        statusText.innerText = "❌ Es wurden keine Vokabelstrukturen erkannt. Bitte stelle sicher, dass die Tabelle gut lesbar ist.";
    }
}

// Analysiert den Textfortschritt und hängt neue Vokabeln an den Pool an
function processOcrTextChunk(text) {
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 3);
    const container = document.getElementById('scanned-container');

    lines.forEach((line) => {
        let enWort = "";
        let deWort = "";
        let satz = "";
        
        try {
            // 1. Hauptstrategie: Suche nach den Lautschrift-Klammern [ ] oder / / als Spaltentrenner
            let bracketMatch = line.match(/^(.*?)\s*[\[\/](.*?)[\]\/]\s*(.*)$/);
            
            if (bracketMatch && bracketMatch[1] && bracketMatch[3]) {
                enWort = bracketMatch[1].trim();
                let rest = bracketMatch[3].trim();
                
                // Bereinige Zahlen am Zeilenanfang (z.B. "1 oral" -> "oral")
                enWort = enWort.replace(/^\d+\s+/, '');
                
                // Trenne das Deutsche vom englischen Beispielsatz
                let splitResult = splitGermanAndSentence(rest, enWort);
                deWort = splitResult.de;
                satz = splitResult.sentence;
            } else {
                // 2. Fallback: Falls keine Klammern da sind, trenne nach großen Lücken
                let parts = line.split(/\s{2,}|\t|;|—/);
                if (parts.length >= 2) {
                    enWort = parts[0].trim().replace(/^\d+\s+/, '');
                    deWort = parts[1].trim();
                    satz = parts.slice(2).join(" ").trim() || `Context: ${enWort}`;
                }
            }
            
            // Validierung: Wenn englisches und deutsches Fragment isoliert wurden
            if (enWort.length > 1 && deWort.length > 1) {
                let cleanEn = enWort.replace(/^to\s+/i, '').trim(); // Für die Überprüfung beim Abfragen
                
                if (!vocabularyPool.some(v => v.en.toLowerCase() === cleanEn.toLowerCase())) {
                    let vocItem = {
                        de: deWort,
                        en: cleanEn,
                        fullEn: enWort,
                        sentence: satz
                    };
                    
                    vocabularyPool.push(vocItem);

                    let row = document.createElement('div');
                    row.className = 'scanned-item';
                    row.innerHTML = `<span><strong>${vocItem.fullEn}</strong> ➔ ${vocItem.de}</span>`;
                    container.appendChild(row);
                }
            }
        } catch (e) {
            console.error("Fehler beim Verarbeiten einer Zeile: ", e);
        }
    });
    
    document.getElementById('scanned-title').innerText = `Erkannte Vokabeln (${vocabularyPool.length}):`;
}

// Hilfsfunktion trennt deutsche Bedeutung und den Beispielsatz voneinander
function splitGermanAndSentence(rest, enWort) {
    let cleanRest = rest.toLowerCase();
    let sentenceStart = -1;
    
    // Typische englische Signalwörter, die den Satzanfang im Buch markieren
    const starters = [
        "the ", "an ", "a ", "what ", "they ", "she ", "he ", "it ", "there ", 
        "this ", "in ", "let's ", "my ", "how ", "people ", "after ", "dogs ", 
        "claire ", "some ", "we ", "you ", "i ", "our ", "their ", "gales ", "put "
    ];
    
    for (let starter of starters) {
        let sIdx = cleanRest.indexOf(starter);
        if (sIdx !== -1) {
            sentenceStart = sIdx;
            break;
        }
    }
    
    // Fallback: Suche nach dem ersten Großbuchstaben
    if (sentenceStart === -1) {
        let matches = [...rest.matchAll(/[A-Z][a-z]+/g)];
        if (matches.length > 0) {
            for (let m of matches) {
                let word = m.toLowerCase();
                if (starters.includes(word + " ") || m.index > rest.length / 3) {
                    sentenceStart = m.index;
                    break;
                }
            }
            if (sentenceStart === -1) {
                sentenceStart = matches[matches.length - 1].index;
            }
        }
    }
    
    if (sentenceStart !== -1 && sentenceStart < rest.length - 5) {
        return {
            de: rest.substring(0, sentenceStart).trim().replace(/[;,\- ]+$/, ''),
            sentence: rest.substring(sentenceStart).trim()
        };
    }
    
    // Letzter Ausweg: Halbiere den Text in der Mitte
    return {
        de: rest.substring(0, rest.length / 2).trim(),
        sentence: rest.substring(rest.length / 2).trim()
    };
}

// Trainer starten
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

// Frage anzeigen
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

// Antwort prüfen
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
// Phasenwechsel steuern
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
