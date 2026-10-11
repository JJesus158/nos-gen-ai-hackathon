import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, signal } from '@angular/core';

export type Language = 'en' | 'pt-PT';
const en = {
  title: 'DataVeil',
  navigation: 'Main navigation',
  appearance: 'Appearance',
  light: 'Light',
  dark: 'Dark',
  system: 'System',
  language: 'Language',
  english: 'English',
  portuguese: 'Português (Portugal)',
  documentProgress: 'Document progress',
  documentStep: 'Document',
  analysisStep: 'Analysis',
  anonymizationStep: 'Anonymization',
  resultsStep: 'Results',
  stepComplete: 'complete',
  skip: 'Skip to content',
  heroTitle: 'Document anonymization',
  heroDescription:
    'Upload your document and take the first step toward intelligent data protection.',
  resultsDescription: 'Review the protected version, then download your document.',
  authors: 'Duarte, Guilherme, João and Joel',
  footerNote: 'Your files are never sent to a server.',
  apiFooterNote: 'Documents are sent for analysis and anonymization.',
  uploadTitle: 'Select a document',
  dropTitle: 'Drop your document here',
  chooseFile: 'Choose document',
  fileHint: 'One document at a time',
  remove: 'Remove file',
  startAnalysis: 'Start analysis',
  fileError: 'Please select one document in PDF format.',
  emptyPdf: 'The selected document is empty. Please choose another document.',
  analysisTitle: 'Review analysis',
  complete: 'Analysis complete',
  documentPreview: 'Document preview',
  firstPagePreview: 'First page preview',
  previewLoading: 'Loading preview…',
  previewUnavailable: 'Preview unavailable',
  pdfMappingUnavailable:
    'PDF highlights are unavailable for this analysis. Showing the analyzed text; analyze the document again to refresh its PDF positions.',
  sampleDocument: 'Example document',
  entities: 'Personal data',
  identifiedEntities: 'Identified items',
  noEntities: 'No personal data identified',
  processing: 'Analyzing document…',
  processingError: 'The document could not be analyzed. Please try again.',
  selectionInstructions: 'Choose the data to anonymize.',
  selectAll: 'Select all',
  selectedItems: 'selected',
  anonymizeSelected: 'Anonymize selected data',
  anonymizing: 'Anonymizing document…',
  anonymizationWaitingTitle: 'Protecting your document',
  anonymizationWaitingMessage: 'Wait while we are applying your choices.',
  anonymizationError: 'The document could not be anonymized. Please try again.',
  categoryName: 'Names',
  categoryId: 'Identifiers',
  categoryContact: 'Contact details',
  categoryDob: 'Dates of birth',
  categoryFinancial: 'Financial data',
  categoryHealth: 'Health',
  categorySpecial: 'Sensitive data',
  categoryPrivateLife: 'Private life',
  categoryAge: 'Ages',
  categoryOccupation: 'Occupations',
  categoryClinician: 'Healthcare professionals',
  categorySex: 'Sex and gender',
  categoryOther: 'Other personal data',
  maskMode: 'Choose how to hide sensitive data',
  blur: 'Blurred',
  asterisks: 'Asterisks',
  person: 'Person',
  address: 'Address',
  location: 'Location',
  email: 'Email',
  viewResults: 'View results',
  chooseAnother: 'Choose another document',
  back: 'Back',
  backToReview: 'Back to review',
  resultsTitle: 'Compare the two versions',
  original: 'Original',
  anonymized: 'Anonymized',
  originalTag: 'Before',
  anonymizedTag: 'After',
  download: 'Download document',
  processAnother: 'Select another document',
  bytes: 'bytes',
  manualHint: 'Select text in the document to mark data that was not identified.',
  previewViewLabel: 'Preview',
  pdfView: 'PDF',
  textView: 'Text',
  markAsPersonalData: 'Mark as personal data',
  category: 'Category',
  newCategory: 'New category…',
  newCategoryName: 'Category name',
  markOtherOccurrence: 'Also mark the other occurrence',
  markOtherOccurrences: 'Also mark the other {count} occurrences',
  add: 'Add',
  cancel: 'Cancel',
  close: 'Close',
  manualOverlap:
    'This text overlaps data that is already identified. Select only the missing part.',
  manualDeselected: 'This text is already in the list, but it is not selected for anonymization.',
  selectExisting: 'Select it',
  manualBadge: 'Added by you',
  removeManual: 'Remove',
  manualAdded: 'Added to {category}',
};
const pt: typeof en = {
  title: 'DataVeil',
  navigation: 'Navegação principal',
  appearance: 'Aparência',
  light: 'Claro',
  dark: 'Escuro',
  system: 'Sistema',
  language: 'Idioma',
  english: 'English',
  portuguese: 'Português (Portugal)',
  documentProgress: 'Progresso do documento',
  documentStep: 'Documento',
  analysisStep: 'Análise',
  anonymizationStep: 'Anonimização',
  resultsStep: 'Resultados',
  stepComplete: 'concluído',
  skip: 'Saltar para o conteúdo',
  heroTitle: 'Anonimização de documentos',
  heroDescription:
    'Carregue o seu documento e dê o primeiro passo para uma proteção inteligente dos seus dados.',
  resultsDescription: 'Reveja a versão protegida e descarregue o seu documento.',
  authors: 'Duarte, Guilherme, João e Joel',
  footerNote: 'Os seus ficheiros não são enviados para nenhum servidor.',
  apiFooterNote: 'O documento é enviado para análise e anonimização.',
  uploadTitle: 'Selecione um documento',
  dropTitle: 'Arraste o seu documento para aqui',
  chooseFile: 'Escolher documento',
  fileHint: 'Um documento de cada vez',
  remove: 'Remover ficheiro',
  startAnalysis: 'Iniciar análise',
  fileError: 'Selecione um documento em formato PDF.',
  emptyPdf: 'O documento selecionado está vazio. Escolha outro documento.',
  analysisTitle: 'Rever análise',
  complete: 'Análise concluída',
  documentPreview: 'Pré-visualização do documento',
  firstPagePreview: 'Pré-visualização da primeira página',
  previewLoading: 'A carregar pré-visualização…',
  previewUnavailable: 'Pré-visualização indisponível',
  pdfMappingUnavailable:
    'Os destaques no PDF não estão disponíveis nesta análise. A mostrar o texto analisado; analise novamente o documento para atualizar as posições no PDF.',
  sampleDocument: 'Documento de exemplo',
  entities: 'Dados pessoais',
  identifiedEntities: 'Elementos identificados',
  noEntities: 'Não foram identificados dados pessoais',
  processing: 'A analisar o documento…',
  processingError: 'Não foi possível analisar o documento. Tente novamente.',
  selectionInstructions: 'Escolha os dados que pretende anonimizar.',
  selectAll: 'Selecionar tudo',
  selectedItems: 'selecionados',
  anonymizeSelected: 'Anonimizar dados selecionados',
  anonymizing: 'A anonimizar o documento…',
  anonymizationWaitingTitle: 'A proteger o seu documento',
  anonymizationWaitingMessage: 'Aguarde enquanto aplicamos as suas preferências.',
  anonymizationError: 'Não foi possível anonimizar o documento. Tente novamente.',
  categoryName: 'Nomes',
  categoryId: 'Identificadores',
  categoryContact: 'Contactos',
  categoryDob: 'Datas de nascimento',
  categoryFinancial: 'Dados financeiros',
  categoryHealth: 'Saúde',
  categorySpecial: 'Dados sensíveis',
  categoryPrivateLife: 'Vida privada',
  categoryAge: 'Idades',
  categoryOccupation: 'Profissões',
  categoryClinician: 'Profissionais de saúde',
  categorySex: 'Sexo e género',
  categoryOther: 'Outros dados pessoais',
  maskMode: 'Escolha como ocultar os dados sensíveis',
  blur: 'Desfocado',
  asterisks: 'Asteriscos',
  person: 'Pessoa',
  address: 'Morada',
  location: 'Localidade',
  email: 'Email',
  viewResults: 'Ver resultados',
  chooseAnother: 'Escolher outro documento',
  back: 'Voltar',
  backToReview: 'Voltar à revisão',
  resultsTitle: 'Comparar as duas versões',
  original: 'Original',
  anonymized: 'Anonimizado',
  originalTag: 'Antes',
  anonymizedTag: 'Depois',
  download: 'Descarregar documento',
  processAnother: 'Selecionar outro documento',
  bytes: 'bytes',
  manualHint: 'Selecione texto para marcar dados não identificados.',
  previewViewLabel: 'Pré-visualização',
  pdfView: 'PDF',
  textView: 'Texto',
  markAsPersonalData: 'Marcar como dado pessoal',
  category: 'Categoria',
  newCategory: 'Nova categoria…',
  newCategoryName: 'Nome da categoria',
  markOtherOccurrence: 'Marcar também a outra ocorrência',
  markOtherOccurrences: 'Marcar também as outras {count} ocorrências',
  add: 'Adicionar',
  cancel: 'Cancelar',
  close: 'Fechar',
  manualOverlap:
    'Este texto sobrepõe-se a dados já identificados. Selecione apenas a parte em falta.',
  manualDeselected: 'Este texto já está na lista, mas não está selecionado para anonimizar.',
  selectExisting: 'Selecionar',
  manualBadge: 'Adicionado por si',
  removeManual: 'Remover',
  manualAdded: 'Adicionado a {category}',
};

/** Every translation, e.g. to recognise a built-in category label typed in either language. */
export const TRANSLATIONS: readonly (typeof en)[] = [en, pt];

@Injectable({ providedIn: 'root' })
export class LanguageService {
  private readonly document = inject(DOCUMENT);
  private readonly selected = signal<Language>(this.readPreference());
  readonly preference = this.selected.asReadonly();
  readonly text = computed(() => (this.preference() === 'en' ? en : pt));

  constructor() {
    this.apply();
  }

  setPreference(language: Language): void {
    this.selected.set(language);
    try {
      this.document.defaultView!.localStorage.setItem('language', language);
    } catch {
      /* Storage can be unavailable. */
    }
    this.apply();
  }

  private readPreference(): Language {
    try {
      if (this.document.defaultView!.localStorage.getItem('language') === 'pt-PT') return 'pt-PT';
    } catch {
      /* Fall back to English. */
    }
    return 'en';
  }

  private apply(): void {
    this.document.documentElement.lang = this.preference();
    this.document.title = this.text().title;
  }
}
