import type { DocumentProcessor } from './document-processor';

/** Local fixture only. The selected document is never read or sent by this processor. */
export const exampleDocumentProcessor: DocumentProcessor = {
  async analyze(_file, signal) {
    checkCancellation(signal);
    const originalText = [
      'Ficha de acompanhamento',
      'Nome: Ana Correia',
      'Idade: 34 anos',
      'NIF: 123456789',
      'Morada: Rua da Liberdade, 12, 1000-001 Lisboa',
      'Email: ana@example.com',
      'Diagnóstico: asma',
      'Medicação: salbutamol, 100 µg',
      'Contacto de emergência: Ana Correia',
    ].join('\n');
    let cursor = 0;
    const entities = [
      { text: 'Ana Correia', type: 'NAME', replacement: '[NOME]' },
      { text: '34 anos', type: 'AGE', replacement: '[IDADE]' },
      { text: '123456789', type: 'ID', replacement: '[IDENTIFICADOR]' },
      {
        text: 'Rua da Liberdade, 12, 1000-001 Lisboa',
        type: 'CONTACT',
        replacement: '[MORADA]',
      },
      { text: 'ana@example.com', type: 'CONTACT', replacement: '[EMAIL]' },
      { text: 'asma', type: 'HEALTH', replacement: '[SAÚDE]' },
      { text: 'salbutamol, 100 µg', type: 'HEALTH', replacement: '[MEDICAÇÃO]' },
      { text: 'Ana Correia', type: 'NAME', replacement: '[NOME]' },
    ].map(({ text, type, replacement }, index) => {
      const start = originalText.indexOf(text, cursor);
      cursor = start + text.length;
      return { id: `entity-${index + 1}`, start, end: cursor, type, replacement };
    });
    return { id: 'example-document', originalText, entities, source: 'example' };
  },
  async anonymize(analysis, selectedEntityIds, signal) {
    checkCancellation(signal);
    const selected = new Set(selectedEntityIds);
    const entities = analysis.entities.filter((entity) => selected.has(entity.id));
    let anonymizedText = analysis.originalText;
    for (const entity of [...entities].sort((a, b) => b.start - a.start)) {
      anonymizedText =
        anonymizedText.slice(0, entity.start) +
        entity.replacement +
        anonymizedText.slice(entity.end);
    }
    return {
      originalText: analysis.originalText,
      anonymizedText,
      entities,
      download: {
        name: 'dataveil-example.txt',
        blob: new Blob([anonymizedText], { type: 'text/plain;charset=utf-8' }),
      },
      source: 'example',
    };
  },
  async summarize(_analysis, _selectedEntityIds, language, signal) {
    checkCancellation(signal);
    return language === 'pt-PT'
      ? 'Ficha de acompanhamento de uma paciente. O documento contém dados pessoais, um diagnóstico e medicação prescrita, todos protegidos.'
      : 'Follow-up record of a patient. The document contains personal data, a diagnosis and prescribed medication, all protected.';
  },
};

function checkCancellation(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
}
