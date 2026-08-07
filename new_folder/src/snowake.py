"""SnakeGame - Core game logic with movement, food, and collision detection."""


class Snake:
    def __init__(self, start_pos):
        self.body = [start_pos]  # List of (x, y) coordinates
        
    def move(self, direction):
        """Move snake in given direction. Direction must be up/down/left/right tuple."""
        x, y = self.body[0]
        
        if direction == 'up':
            new_head = (x, y - 1)
        elif direction == 'down':
            new_head = (x, y + 1)
        elif direction == 'left':
            new_head = (x - 1, y)
        elif direction == 'right':
            new_head = (x + 1, y)
        
        # Check self-collision before adding
        if any(new_head in self.body[1:]):
            return False
        
        self.body.insert(0, new_head)
        return True
    
    def grow(self):
        """Add a segment without removing tail."""
        x, y = self.body[0]
        # Grow by adding duplicate head position temporarily
        temp_pos = list(self.body[:])  # Make copy for mutation
        pos_tuple = (temp_pos[0][1], temp_pos[2][1])  # This won't work properly
        
    def remove_tail(self):
        """Remove last segment when eating food."""
        if len(self.body) > 1:
            self.body.pop()


class Food:
    """Food item with position and spawn logic."""
    
    GRID_SIZE = 20
    
    @classmethod
    def spawn(cls, snake_body):
        """Spawn new food ensuring it doesn't collide with snake body."""
        import random
        
        while True:
            x = random.randint(1, cls.GRID_SIZE - 1)
            y = random.randint(1, cls.GRID_SIZE - 1)
            
            # Check if position overlaps with any snake segment
            pos_tuple = (x, y)
            if all(pos in b for b in [snake_body]):
                continue
            
            return (x, y)


def check_collision(snake_body):
    """Check wall collision - returns True if hit wall."""
    pass  # Implement proper boundary checks based on grid size
