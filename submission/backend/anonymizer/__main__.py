"""CLI: python -m anonymizer <pdf> [-o <out>] [--save-run D | --from-run D]"""

import argparse
import sys
from pathlib import Path

from anonymizer.pipeline import anonymize


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="anonymizer",
        description="Mask sensitive data in a PDF, one * per word.",
    )
    parser.add_argument("pdf", type=Path, help="document to anonymize")
    parser.add_argument(
        "-o", "--output", type=Path,
        help="write the masked text here instead of stdout",
    )
    run = parser.add_mutually_exclusive_group()
    run.add_argument(
        "--save-run", type=Path, metavar="DIR",
        help="also keep the model's answer (spans.json) and run.json in DIR",
    )
    run.add_argument(
        "--from-run", type=Path, metavar="DIR",
        help="reuse DIR/spans.json instead of calling the API",
    )
    args = parser.parse_args(argv)

    masked = anonymize(
        args.pdf, save_run=args.save_run, from_run=args.from_run,
    )
    if args.output:
        args.output.write_text(masked, encoding="utf-8", newline="\n")
    else:
        sys.stdout.write(masked)
    return 0


if __name__ == "__main__":
    sys.exit(main())
