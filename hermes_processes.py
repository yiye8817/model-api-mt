"""Stop OCR terminal descendants even when Hermes tools create new sessions."""
import os
from pathlib import Path
import subprocess


def _process_table():
    result={}
    if Path('/proc').is_dir():
        for entry in Path('/proc').iterdir():
            if not entry.name.isdigit():continue
            try:
                fields=(entry/'stat').read_text().rsplit(')',1)[1].split()
                result[int(entry.name)]=(int(fields[1]),fields[19])
            except (OSError,ValueError,IndexError):continue
    else:
        try:
            listing=subprocess.run(['ps','-axo','pid=,ppid=,lstart='],capture_output=True,text=True,timeout=3,check=True)
            for line in listing.stdout.splitlines():
                pid,parent,started=line.strip().split(None,2)
                result[int(pid)]=(int(parent),started)
        except (OSError,ValueError,subprocess.SubprocessError):pass
    return result


def stop_descendants(root,signal_number,known):
    table=_process_table();children={}
    for pid,(parent,started) in table.items():children.setdefault(parent,[]).append(pid)
    remembered=dict(known);pending=[root];seen={root}
    while pending:
        for pid in children.get(pending.pop(),[]):
            if pid in seen:continue
            seen.add(pid);pending.append(pid);remembered[pid]=table[pid][1]
    # Start times prevent an exited child's reused PID from being signalled later.
    for pid,started in remembered.items():
        if pid==os.getpid() or table.get(pid,(None,None))[1]!=started:continue
        try:os.kill(pid,signal_number)
        except ProcessLookupError:pass
    return remembered
