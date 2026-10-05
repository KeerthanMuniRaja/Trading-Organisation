"""Export a reviewable starter curriculum from the installed bundled example. No API or fitting."""
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
from pathlib import Path

from bridge import verify_dependencies
from lab import HERE, exclusive_run, load_returns, replace_report


def main():
    directory = HERE.parents[1] / '.local' / 'organisation-starter'
    directory.mkdir(parents=True, exist_ok=True)
    with exclusive_run(directory / 'prepare.lock'):
        destination = directory / 'plan.json'
        if not destination.exists():
            dependencies = verify_dependencies()
            returns = load_returns().sort_index(axis=1)
            if not 4 <= len(returns.columns) <= 20:
                raise ValueError('Unsupported bundled example asset count')

            def rows(frame):
                return [{'timestamp': instant.strftime('%Y-%m-%dT00:00:00.000Z'),
                         'returns': [float(value) for value in values]}
                        for instant, values in zip(frame.index, frame.to_numpy())]

            windows = []
            for index in range(9):
                split = 252 + index * 63
                training, holdout = returns.iloc[split - 252:split], returns.iloc[split:split + 63]
                if len(training) != 252 or len(holdout) != 63:
                    raise ValueError('Insufficient bundled example observations')
                windows.append({'training': rows(training), 'holdout': rows(holdout)})
            plan = {'schema': 'organisation-starter-v1', 'createdAt': datetime.now(timezone.utc).isoformat(),
                    'provenance': {'package': 'skfolio', 'version': importlib.metadata.version('skfolio'),
                                   'dependencyLockSha256': dependencies, 'loader': 'load_sp500_dataset',
                                   'priorUse': 'Already used by the offline academy; not unseen evaluation data'},
                    'assets': [str(value) for value in returns.columns], 'windows': windows}
            temporary = destination.with_suffix('.tmp')
            temporary.write_text(json.dumps(plan, allow_nan=False, indent=2) + '\n', encoding='utf-8')
            replace_report(temporary, destination)
        content = destination.read_bytes()
        print(json.dumps({'plan': str(destination), 'sha256': hashlib.sha256(content).hexdigest(),
                          'next': 'Review the generated plan before explicit apply. No backend changes or fitting occurred.'}))


if __name__ == '__main__':
    main()
