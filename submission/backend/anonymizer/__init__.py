"""Find and mask sensitive data in a document.

Pipeline: extract text from the PDF, let the LLM detect sensitive spans,
then mask every word of those spans with a single "*".
"""
