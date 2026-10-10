# Document processing API contract

This is the proposed minimum contract for the backend. No backend endpoint is implemented here. Analysis and anonymization are separate requests so users can review the detected data before choosing what to protect.

## 1. Analyze a document

`POST /api/documents/analyze`

- Body: `multipart/form-data` with one required field, `file`, containing the selected PDF and original filename.
- Accept: `application/json`.
- The browser sets the multipart `Content-Type` and boundary automatically.
- The backend validates, extracts and analyzes the document. It retains the source document and analysis under an opaque analysis ID until anonymization completes or the analysis expires.
- The backend determines categories from context. The frontend does not classify document contents.

HTTP `200`, `Content-Type: application/json`:

```json
{
  "id": "analysis-123",
  "originalText": "Nome: Ana; NIF: 123456789",
  "entities": [
    {
      "id": "entity-1",
      "start": 6,
      "end": 9,
      "type": "NAME",
      "replacement": "[NOME]",
      "reason": "Nome de pessoa."
    },
    {
      "id": "entity-2",
      "start": 16,
      "end": 25,
      "type": "ID",
      "replacement": "[IDENTIFICADOR]"
    }
  ]
}
```

`id` is required and identifies this exact document and analysis. `originalText` is required plain text; preserve its spaces and line breaks. The frontend renders it as text, never HTML. UI language must not translate document content.

`entities` is required; an empty array is valid. Each entry represents **one occurrence**, including repeated occurrences of an identical value:

| Field         | Meaning                                                                            |
| ------------- | ---------------------------------------------------------------------------------- |
| `id`          | Nonempty occurrence ID, unique within this analysis and stable across retries.     |
| `start`       | Inclusive, zero-based UTF-16 offset into `originalText`.                           |
| `end`         | Exclusive UTF-16 offset, greater than `start`.                                     |
| `type`        | Category code from the taxonomy below.                                             |
| `replacement` | Plain-text replacement that the backend will apply if this occurrence is selected. |
| `reason`      | Optional plain-text explanation.                                                   |

Ranges must be within `originalText` and must not overlap. Array order may differ from document order. UTF-16 offsets match JavaScript string indices; backends using Unicode code-point indices must convert them, especially for characters outside the BMP such as emoji. Distinct IDs allow users to protect one occurrence of a repeated value while leaving another visible.

### Categories

| Code           | Contextual meaning                                                                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NAME`         | Names of the person, relatives and contacts; a first name alone counts.                                                                                                                      |
| `ID`           | Any personal identifier: NIF, Cartão de Cidadão, NISS, health number, passport or biometric ID.                                                                                              |
| `CONTACT`      | Phone, email or home address, including postal code and city.                                                                                                                                |
| `DOB`          | Date of birth.                                                                                                                                                                               |
| `FINANCIAL`    | Card number, expiry, CVV, IBAN, income, insurance plan or policy number.                                                                                                                     |
| `HEALTH`       | Symptoms, diagnoses, medication and doses, exams and results, allergies, procedures, measurements (height, weight, blood pressure, blood type), family history or diagnosis/treatment dates. |
| `SPECIAL`      | Ethnicity, religion, political opinion, sexual orientation or genetic data.                                                                                                                  |
| `PRIVATE_LIFE` | Marital status, children, kinship/friendship, habits (smoking, alcohol), addictions or personal problems.                                                                                    |
| `AGE`          | The person's age.                                                                                                                                                                            |
| `OCCUPATION`   | Job or employer.                                                                                                                                                                             |
| `CLINICIAN`    | Treating professional's name, registration, specialty, work phone or email.                                                                                                                  |
| `SEX`          | Sex or gender.                                                                                                                                                                               |

Other personal information belongs to the closest category; if two categories fit, the more specific category wins. Context matters: a treating clinician's name belongs to `CLINICIAN`, while a patient's name belongs to `NAME`; diagnosis dates belong to `HEALTH`, birth dates to `DOB`. The API owns these decisions. Unknown nonempty category codes remain selectable with a fallback presentation for forward compatibility.

The frontend initially selects every occurrence. Users can select/deselect all occurrences, a complete category, or individual occurrences. Category controls reflect partial selection. Choosing a file alone keeps progress at step 1; starting analysis advances to step 2. Selection remains at step 2 until anonymization starts.

## 2. Anonymize the selected occurrences

`POST /api/documents/{analysisId}/anonymize`

URL-encode the analysis ID. Body: `application/json`:

```json
{
  "selectedEntityIds": ["entity-1"]
}
```

The list is explicit and exhaustive: only `entity-1` is protected in this example. An empty list means **protect nothing**, not protect everything. Omitted, duplicate, unknown or stale IDs must produce `400` or `422`; IDs must belong to the identified analysis. The backend must generate both preview text and downloadable document using this exact selection. It must preserve unselected occurrences and must not return a previously generated file with all occurrences masked.

The body may also contain `manualEntities`: the occurrences the user marked by hand in the document preview and kept selected. They are not part of the analysis, so they never appear in `selectedEntityIds`:

```json
{
  "selectedEntityIds": ["entity-1", "entity-3"],
  "manualEntities": [
    { "start": 120, "end": 131, "type": "NAME" },
    { "start": 200, "end": 208, "type": "custom:Matrícula" }
  ]
}
```

| Field   | Meaning                                                                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start` | Inclusive, zero-based UTF-16 offset into `originalText`, the same convention as analysis entities (JavaScript string indices).                          |
| `end`   | Exclusive UTF-16 offset, greater than `start` and at most the UTF-16 length of `originalText`. A range may span line breaks.                            |
| `type`  | Nonempty string of at most 100 characters: a category code from the taxonomy, or a user-defined category, which the frontend sends as `custom:<label>`. |

`manualEntities` is optional. When it is absent or empty, the request behaves exactly as without it; the frontend sends the key only when it is non-empty. `selectedEntityIds` stays required: with an empty list, only the manual occurrences are protected. The backend masks every word that a range touches with exactly the same word rules as detected occurrences: each touched whitespace-separated word becomes one `*`, sentence punctuation at the word edges is kept, and spaces and line breaks are unchanged, so `Rua da Liberdade, 12` becomes `* * *, *`. Masking applies at that exact position only; the same value elsewhere in the document is not masked by it. Ranges may overlap each other or detected occurrences, and masking is their union; the frontend never sends overlapping ranges, but they are not an error. The backend does not interpret `type` beyond validating it and stores nothing about these occurrences. The response shape is unchanged.

A negative `start`, an `end` not greater than `start` or beyond the UTF-16 length of `originalText`, or a `start` or `end` in the middle of a surrogate pair returns `400` with `{ "message": "Invalid manual entity range" }`. Schema errors, such as a missing or non-integer offset, an empty or too long `type`, or more than 5000 `manualEntities`, may return `422`.

HTTP `200`, `Content-Type: application/json`:

```json
{
  "anonymizedText": "Nome: [NOME]; NIF: 123456789",
  "download": {
    "name": "document-anonymized.txt",
    "mediaType": "text/plain;charset=utf-8",
    "contentBase64": "Tm9tZTogW05PTUVdOyBOSUY6IDEyMzQ1Njc4OQ=="
  }
}
```

`anonymizedText` is required plain text for the preview, with spaces and line breaks preserved. The frontend does not reconstruct backend output from entity replacements or translate it.

`download` is required and contains the actual document generated for the selected occurrences:

- `name`: nonempty filename with extension.
- `mediaType`: nonempty MIME type, such as `application/pdf` or `text/plain;charset=utf-8`.
- `contentBase64`: standard base64 of the exact bytes, without a data-URL prefix. Encode text as UTF-8 before base64 encoding. The example decodes to `Nome: [NOME]; NIF: 123456789`.

The frontend decodes the bytes into a `Blob` and downloads the file unchanged. PDF output is supported when provided by the backend; the text preview still uses `anonymizedText`. The internal result combines this response with the original analysis and **selected** entities; `source: 'api'` is frontend metadata, not a backend field.

Successful generation advances progress through anonymization (step 3) to results (step 4). Generation failures return to review with the user's choices preserved. Retrying with the same analysis and selection must remain safe; the API controls retention and expiration. Base64 increases response size; a binary download endpoint can replace it later if needed.

## Errors and cancellation

Return a non-success HTTP status, optionally with `{ "message": "..." }`:

| Status        | Meaning                                                                      |
| ------------- | ---------------------------------------------------------------------------- |
| `400`         | Missing or malformed input, invalid selection IDs.                           |
| `404` / `410` | Analysis does not exist or has expired; the document must be analyzed again. |
| `413`         | File exceeds the backend's size limit.                                       |
| `415`         | Unsupported document format.                                                 |
| `422`         | Document cannot be processed or selection does not belong to this analysis.  |
| `500`         | Processing failed unexpectedly.                                              |

The frontend shows a translated error and allows retry. It rejects malformed responses, duplicate IDs, invalid/overlapping ranges and invalid base64. Removing or replacing the document aborts pending browser requests and discards late responses from either stage. This does not guarantee backend computation stops; backend retention and cancellation are backend responsibilities.

Both requests are synchronous responses; polling, authentication, proxy configuration and backend implementation are outside this contract.

## Enable the backend

Set `DOCUMENT_API_URL` in `src/app/app.config.ts` from `null` to `/api/documents`, or the full backend base URL. A separate origin must allow the frontend origin through CORS. No Angular proxy is configured.

With `null`, the local example processor remains active. It uses a fixed fixture, applies the selected occurrences to that fixture, and provides a matching TXT download. It does not read or upload the selected document for analysis. A separate local first-page preview may read the selected file in the browser; this does not send it to a server. With a URL, the adapter uploads the selected document using native `fetch` and passes an `AbortSignal` to both requests. The footer reflects the active mode. Only language and appearance preferences are persisted; documents and analysis selections are not stored in localStorage.
