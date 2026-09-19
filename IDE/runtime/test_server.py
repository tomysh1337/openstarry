import importlib.util
from pathlib import Path
import unittest
spec = importlib.util.spec_from_file_location('runner', Path(__file__).with_name('server.py'))
runner = importlib.util.module_from_spec(spec); spec.loader.exec_module(runner)
class RunnerTests(unittest.TestCase):
    def test_project_validation(self):
        runner.validate_files({'src/main.py': 'print(1)'})
        for files in [{'../outside': 'x'}, {'/tmp/a': 'x'}, {'C:/x': ''}, {'a': '', 'A': ''}, {'a': '', 'a/b': ''}, {'a': '\0'}]:
            with self.assertRaises(ValueError): runner.validate_files(files)
    def test_limits_and_isolation_are_part_of_every_job(self):
        args = runner.docker_command('id', '/tmp/test', 'python', 'python main.py')
        for value in ['--network=none', '--read-only', '--cap-drop=ALL', '--pids-limit=128', '--memory=512m', '--user=65534:65534']:
            self.assertIn(value, args)
        self.assertEqual(args[-3:], ['sh', '-lc', 'python main.py'])
if __name__ == '__main__': unittest.main()
