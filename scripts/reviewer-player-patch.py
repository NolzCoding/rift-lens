import sys

path = sys.argv[1]
s = open(path, encoding="utf8").read()


def rep(old, new):
    global s
    assert s.count(old) == 1, f"{s.count(old)}x: {old[:80]!r}"
    s = s.replace(old, new)


rep('''def quick_payload(
    replay_path: Path, champions: tuple[str, ...], progress: Progress = emit_default
) -> dict[str, object]:''', '''def quick_payload(
    replay_path: Path, champions: tuple[str, ...], progress: Progress = emit_default, player: str | None = None
) -> dict[str, object]:''')

rep('''        wanted = [
            (index, participant)
            for index, participant in enumerate(participants)
            if str(participant.get("SKIN")) in champions
        ]
        if not wanted:
            raise ValueError(f"None of {', '.join(champions)} were found in this replay")''', '''        # Review the uploading player (by Riot ID) on any champion; bot laners keep their lane partner for the duo
        # review. The champion list is only the fallback when no player is given or the player is not in the replay.
        def is_player(participant: dict[str, object]) -> bool:
            if not player:
                return False
            target = player.strip().lower()
            name = participant_name(participant).lower()
            return name == target or ("#" not in target and name.split("#")[0] == target)

        duo_positions = {"BOTTOM", "UTILITY"}
        lane_positions = duo_positions
        me = [(index, participant) for index, participant in enumerate(participants) if is_player(participant)]
        if me:
            my_index, my_row = me[0]
            my_team = as_int(my_row.get("TEAM"))
            my_position = str(my_row.get("TEAM_POSITION") or my_row.get("INDIVIDUAL_POSITION") or "")
            if my_position in duo_positions:
                partners = [
                    (index, participant)
                    for index, participant in enumerate(participants)
                    if index != my_index
                    and as_int(participant.get("TEAM")) == my_team
                    and str(participant.get("TEAM_POSITION")) in duo_positions
                ]
                wanted = me + partners
            else:
                wanted = me
                lane_positions = {my_position} if my_position else duo_positions
        else:
            wanted = [
                (index, participant)
                for index, participant in enumerate(participants)
                if str(participant.get("SKIN")) in champions
            ]
        if not wanted:
            who = f"{player} or any of " if player else "None of "
            raise ValueError(f"{who}{', '.join(champions)} were found in this replay")''')

rep('''            if str(item.get("TEAM_POSITION")) in {"BOTTOM", "UTILITY"}
        ]''', '''            if str(item.get("TEAM_POSITION")) in lane_positions
        ]''')

rep('''    champions: tuple[str, ...] = ("Viktor", "Lux"),
    progress: Progress = emit_default,
    json_output: Path | None = None,
) -> tuple[Path, str]:''', '''    champions: tuple[str, ...] = ("Viktor", "Lux"),
    progress: Progress = emit_default,
    json_output: Path | None = None,
    player: str | None = None,
) -> tuple[Path, str]:''')

rep('''    quick = quick_payload(replay_path, champions, progress)''', '''    quick = quick_payload(replay_path, champions, progress, player)''')

rep('''    parser.add_argument("--json-output", type=Path, help="write structured web-app JSON")
    args = parser.parse_args(argv)
    try:
        output, _ = analyze(
            args.replay,
            deep=not args.quick,
            json_output=args.json_output,
        )''', '''    parser.add_argument("--json-output", type=Path, help="write structured web-app JSON")
    parser.add_argument("--player", help="Riot ID (Name#TAG) of the player to review, on any champion")
    parser.add_argument("--champions", help="comma-separated fallback champions (default: Viktor,Lux)")
    args = parser.parse_args(argv)
    champions = tuple(name.strip() for name in args.champions.split(",") if name.strip()) if args.champions else ("Viktor", "Lux")
    try:
        output, _ = analyze(
            args.replay,
            deep=not args.quick,
            json_output=args.json_output,
            champions=champions,
            player=args.player,
        )''')

open(path, "w", encoding="utf8").write(s)
print("patched")
